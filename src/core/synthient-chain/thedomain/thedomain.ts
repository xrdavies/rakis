import { EmbeddingEngine } from "../../embeddings/embedding-engine";
import { EmbeddingModelName } from "../../embeddings/types";
import { LLMEngine } from "../../llm/llm-engine";
import { LLMModelName } from "../../llm/types";
import { InferenceDB } from "../db/inferencedb";
import {
  InferenceRequest,
  InferenceSuccessResult,
  TransmittedPeerPacket,
} from "../db/packet-types";
import { PacketDB } from "../db/packetdb";
import { ClientInfo, initClientInfo } from "../identity";
import { P2PNetworkFactory } from "../p2p-networks/networkfactory";
import { P2PNetworkInstance } from "../p2p-networks/p2pnetwork-types";
import { generateRandomString, stringifyDateWithOffset } from "../utils/utils";
import { QUORUM_SETTINGS, THEDOMAIN_SETTINGS } from "./settings";
import { debounce } from "lodash";
import { createLogger, logStyles } from "../utils/logger";

const logger = createLogger("Domain", logStyles.theDomain);

export type DomainStartOptions = {
  identityPassword: string;
  overwriteIdentity?: boolean;
  initialEmbeddingWorkers: {
    modelName: EmbeddingModelName;
    count: number;
  }[];
  initialLLMWorkers: {
    modelName: LLMModelName;
    count: number;
  }[];
};

export class TheDomain {
  private static instance: TheDomain;

  private packetDB: PacketDB;
  private shutdownListeners: (() => void)[] = [];
  private embeddingEngine: EmbeddingEngine;
  private llmEngine: LLMEngine;
  private inferenceDB: InferenceDB;
  private inferenceStatus: {
    inferenceIdsInProcess: string[];
    inferenceCompletionInterval: NodeJS.Timeout | null;
    waitingForWorker: boolean;
    embeddingQueue: {
      model: EmbeddingModelName;
      request:
        | {
            type: "resultEmbedding";
            request: InferenceRequest;
            result: InferenceSuccessResult;
          }
        | {
            type: "consensusVerification";
            requestId: string;
            priorityConsensusVerification: boolean;
          };
      expiresAt: Date;
      queued: boolean;
    }[];
  } = {
    inferenceIdsInProcess: [],
    inferenceCompletionInterval: null,
    waitingForWorker: false,
    embeddingQueue: [],
  };

  private hookupConnections() {
    // Connect received packets from p2p to the packetdb
    for (const p2pNetwork of this.p2pNetworkInstances) {
      const listener = p2pNetwork.listenForPacket(async (packet) => {
        await this.packetDB.receivePacket(packet);
      });

      // TODO: Move all the listeners below into proper named functions and then add unloading them to the shutdown listeners
      this.shutdownListeners.push(() => listener());
    }

    // Send received peer-based inference requests from packetdb to inferencedb
    // TODO: This should be depreated later so we don't have a cycle in our
    // data flow

    this.packetDB.on("newP2PInferenceRequest", (packet) => {
      logger.debug("Saving p2p inference request to our db");
      setTimeout(
        () =>
          this.inferenceDB.saveInferenceRequest({
            fetchedAt: new Date(),
            requestId: packet.requestId,
            payload: packet.payload,
          }),
        0
      );
    });

    // Hook us up to process to inference commits
    this.packetDB.on("newInferenceCommit", (packet) => {
      logger.debug("Processing new inference commit");
      setTimeout(() => this.inferenceDB.saveInferenceCommit(packet), 0);
    });

    // When a reveal is requested, pass it on
    this.packetDB.on("newInferenceRevealRequest", (packet) => {
      setTimeout(() => {
        logger.debug("Processing new inference reveal request");
        this.inferenceDB.processInferenceRevealRequest(packet);
      }, 0);
    });

    // When we get a reveal, pass it to the inferencedb to process
    this.packetDB.on("newInferenceRevealed", (packet) => {
      setTimeout(() => {
        logger.debug("Processing new inference reveal");
        this.inferenceDB.processInferenceReveal(packet);
      }, 0);
    });

    // ############# Set up event-based connections

    // If there's a new consensus quorum that needs to be verified for their
    // emebeddings, start the process
    this.inferenceDB.quorumDb.on(
      "newQuorumAwaitingConsensus",
      (requestId, embeddingModel, consensusRequestedAt, hasMyContribution) => {
        logger.debug(
          "New quorum awaiting consensus verification - ",
          requestId,
          "with our work in there? ",
          hasMyContribution
        );
        if (
          !this.inferenceStatus.embeddingQueue.find(
            (item) =>
              item.request.type === "consensusVerification" &&
              item.request.requestId === requestId
          )
        ) {
          this.inferenceStatus.embeddingQueue.push({
            model: embeddingModel,
            request: {
              type: "consensusVerification",
              requestId,
              priorityConsensusVerification: hasMyContribution,
            },
            expiresAt: new Date(
              consensusRequestedAt.getTime() +
                QUORUM_SETTINGS.quorumConsensusWindowMs
            ),
            queued: false,
          });
        }
        setTimeout(() => this.processEmbeddingQueue(), 0);
      }
    );

    // Once consensus happens, propagate the consensus packets
    // TODO: IMPORTANT Do we save other peoples consensus packets? Maybe if there's not a collision, or save all for posterity?
    this.inferenceDB.quorumDb.on("consensusPackets", (consensusPackets) => {
      logger.debug("New consensus packets, propagating");
      consensusPackets.forEach((packet) => {
        setTimeout(() => this.packetDB.transmitPacket(packet), 0);
      });
    });

    // If inference results are done, move them off to get embedded
    this.inferenceDB.on(
      "inferenceResultAwaitingEmbedding",
      (request, result) => {
        logger.debug("New inference awaiting embedding");
        this.inferenceStatus.embeddingQueue.push({
          model: request.payload.securityFrame.embeddingModel,
          expiresAt: request.endingAt,
          request: {
            type: "resultEmbedding",
            request,
            result,
          },
          queued: false,
        });
        setTimeout(() => this.processEmbeddingQueue(), 0);
      }
    );

    // If embedding workers are free, check for new jobs
    this.embeddingEngine.on("workerFree", () => {
      logger.debug("Worker free, checking for jobs");
      setTimeout(() => this.processEmbeddingQueue(), 0);
    });

    // If embeddings are done, send out the commit message
    this.inferenceDB.on("newInferenceEmbedding", (inferenceEmbedding) => {
      logger.debug("New inference embedding, committing to result");
      this.packetDB.transmitPacket({
        type: "inferenceCommit",
        bEmbeddingHash: inferenceEmbedding.bEmbeddingHash,
        requestId: inferenceEmbedding.requestId,
        inferenceId: inferenceEmbedding.inferenceId,
        createdAt: stringifyDateWithOffset(new Date()),
      });
    });

    // If llm workers are free, check for new jobs
    this.llmEngine.on("workerFree", () => {
      logger.debug("Worker free, checking for jobs");
      setTimeout(() => this.processInferenceRequestQueue(), 0);
    });

    // If new inference requests come in, start the inference loop
    this.inferenceDB.on("newActiveInferenceRequest", (request) => {
      logger.debug("New active inference request, starting inference loop.");
      setTimeout(() => this.processInferenceRequestQueue(), 0);
    });

    // When quorums are ready to be revealed, propagate the requests
    this.inferenceDB.on("requestQuorumReveal", (revealRequests) => {
      setTimeout(() => {
        logger.debug("Publishing reveal requests");
        revealRequests.forEach((revealRequest) => {
          this.packetDB.transmitPacket(revealRequest);
        });
      }, 0);
    });

    this.inferenceDB.on("revealedInference", (inferenceReveal) => {
      setTimeout(() => {
        logger.debug("Publishing revealed inference");
        this.packetDB.transmitPacket(inferenceReveal);
      }, 0);
    });
  }

  private constructor(
    private clientInfo: ClientInfo,
    private p2pNetworkInstances: P2PNetworkInstance<any, any>[],
    initialEmbeddingWorkers: { modelName: EmbeddingModelName; count: number }[],
    initialLLMWorkers: { modelName: LLMModelName; count: number }[]
  ) {
    const broadcastPacket = async (packet: TransmittedPeerPacket) => {
      await Promise.all(
        this.p2pNetworkInstances.map((p) => p.broadcastPacket(packet))
      );
    };

    this.packetDB = new PacketDB(clientInfo, broadcastPacket);
    this.inferenceDB = new InferenceDB(clientInfo.synthientId);

    logger.debug("Databases created.");

    this.embeddingEngine = new EmbeddingEngine();
    this.llmEngine = new LLMEngine();

    logger.debug("Setting up connections...");
    this.hookupConnections();

    // TODO: We want the timeouts in all the dbs to restart on restart, in case it wasn't graceful and we were in the middle of something

    logger.debug("Starting workers...");

    const workerStartPromises: Promise<any>[] = [];
    for (const worker of initialEmbeddingWorkers) {
      workerStartPromises.push(
        this.embeddingEngine.scaleEmbeddingWorkers(
          worker.modelName,
          worker.count
        )
      );
    }
    for (const worker of initialLLMWorkers) {
      workerStartPromises.push(
        this.llmEngine.scaleLLMWorkers(worker.modelName, worker.count)
      );
    }

    this.packetDB.transmitPacket({
      type: "peerStatusUpdate",
      status: "boot",
      createdAt: stringifyDateWithOffset(new Date()),
    });

    // Await the promise if we want to block, but we're fine without I think
    // TODO: This is just for testing!
    if (typeof window !== "undefined") {
      (window as any).theDomain = {
        runInference: (
          prompt: string,
          model: LLMModelName,
          maxTimeMs: number
        ) => {
          this.packetDB.transmitPacket({
            type: "p2pInferenceRequest",
            requestId: generateRandomString(10),
            payload: {
              fromChain: "ecumene",
              blockNumber: 0,
              createdAt: stringifyDateWithOffset(new Date()),
              prompt,
              acceptedModels: [model],
              temperature: 1,
              maxTokens: 2048,
              securityFrame: {
                quorum: 3,
                maxTimeMs,
                secDistance: 450,
                secPercentage: 0.5,
                embeddingModel: "nomic-ai/nomic-embed-text-v1.5",
              },
            },
            createdAt: stringifyDateWithOffset(new Date()),
          });
        },
        updateLLMWorkers: (modelName: LLMModelName, count: number) => {
          this.llmEngine.scaleLLMWorkers(modelName, count);
        },
        llmEngine: this.llmEngine,
      };

      logger.debug("Inference request function exposed.");
    }
  }

  private async processEmbeddingQueue() {
    const runId = generateRandomString(3); // Just for debugging purposes

    logger.debug("EmbeddingQueue: ", runId, ": Starting embedding process.");

    const availableModels = this.embeddingEngine.getAvailableModels();

    logger.debug(
      "EmbeddingQueue: ",
      runId,
      ": Available models - ",
      availableModels
    );

    // Put the soonest ending ones first, let's try and race
    this.inferenceStatus.embeddingQueue = this.inferenceStatus.embeddingQueue
      .filter((item) => item.expiresAt > new Date())
      .sort((a, b) => {
        if (
          a.request.type === "consensusVerification" &&
          a.request.priorityConsensusVerification &&
          (b.request.type !== "consensusVerification" ||
            !b.request.priorityConsensusVerification)
        )
          return -1;
        else if (
          b.request.type === "consensusVerification" &&
          b.request.priorityConsensusVerification &&
          (a.request.type !== "consensusVerification" ||
            !a.request.priorityConsensusVerification)
        )
          return 1;

        if (
          a.request.type === "resultEmbedding" &&
          b.request.type !== "resultEmbedding"
        ) {
          return -1; // result items come before consensus items
        } else if (
          a.request.type !== "resultEmbedding" &&
          b.request.type === "resultEmbedding"
        ) {
          return 1;
        } else {
          // Within each type, sort by the soonest expiring items
          return a.expiresAt.getTime() - b.expiresAt.getTime();
        }
      });

    logger.debug(
      "EmbeddingQueue: ",
      runId,
      ": Sorted embedding queue - ",
      this.inferenceStatus.embeddingQueue
    );

    const itemsToProcess = this.inferenceStatus.embeddingQueue.filter(
      (item) => !item.queued && availableModels.includes(item.model)
    );

    logger.debug(
      "EmbeddingQueue: ",
      runId,
      ": Items to process - ",
      itemsToProcess
    );

    const usableModels = Array.from(
      new Set(itemsToProcess.map((item) => item.model))
    );

    logger.debug("EmbeddingQueue: ", runId, ": Usable models - ", usableModels);

    const availableWorkers = Object.values(
      this.embeddingEngine.embeddingWorkers
    ).filter(
      (worker) => !worker.busy && usableModels.includes(worker.modelName)
    );

    logger.debug(
      "EmbeddingQueue: ",
      runId,
      ": Available workers - ",
      availableWorkers
    );

    if (availableWorkers.length && itemsToProcess.length)
      this.packetDB.transmitPacket({
        type: "peerStatusUpdate",
        status: "computing_bEmbeddingHash",
        embeddingModels: usableModels,
        createdAt: stringifyDateWithOffset(new Date()),
      });

    for (
      let i = 0;
      i < Math.min(availableWorkers.length, itemsToProcess.length);
      i++
    ) {
      const item = itemsToProcess[i];

      item.queued = true;

      // We're doing these one by one for now since we're not sure if running them
      // as a batch will influence the embeddings
      // TODO: For someone else to test
      logger.debug(
        "EmbeddingQueue: ",
        "Embedding ",
        item.request.type,
        " - ",
        item.request.type === "resultEmbedding"
          ? item.request.result!.result
          : item.request.requestId
      );

      let embeddingPayload: string[] = [];

      if (item.request.type === "consensusVerification") {
        const matchingQuorum = await this.inferenceDB.quorumDb.getQuorum(
          item.request.requestId
        );

        if (!matchingQuorum) {
          logger.error(
            "Could not find quorum for consensus verification - ",
            item.request.requestId
          );

          this.inferenceStatus.embeddingQueue =
            this.inferenceStatus.embeddingQueue.filter(
              (item) => item !== itemsToProcess[i]
            );

          // We'll skip one turn (and not maximize throughput, but this really shouldn't happen)
          continue;
        }

        embeddingPayload = matchingQuorum.quorum
          .filter(
            (commit) =>
              !!commit.reveal &&
              commit.synthientId !== this.clientInfo.synthientId
          )
          .map((commit) => commit.reveal!.output);
      } else {
        embeddingPayload = [item.request.result.result.result];
      }

      if (!embeddingPayload.length) {
        logger.error("No embeddings to embed for ", item);

        this.inferenceStatus.embeddingQueue =
          this.inferenceStatus.embeddingQueue.filter(
            (item) => item !== itemsToProcess[i]
          );

        continue;
      }

      logger.debug(
        "EmbeddingQueue: ",
        "Embedding payload - ",
        embeddingPayload
      );

      this.embeddingEngine
        .embedText(embeddingPayload, item.model)
        .then((embeddingResults) => {
          logger.debug(
            "EmbeddingQueue: ",
            "Embedded ",
            item,
            " - ",
            embeddingResults
          );

          // this.inferenceStatus.embeddingQueue =
          //   this.inferenceStatus.embeddingQueue.filter(
          //     (item) => item !== validInferenceResults[i]
          //   );

          if (embeddingResults && embeddingResults.length) {
            if (item.request.type === "resultEmbedding") {
              const embeddingResult = embeddingResults[0];
              this.inferenceDB.saveInferenceEmbedding(item.request.result, {
                inferenceId: item.request.result.inferenceId,
                requestId: item.request.result.requestId,
                embedding: embeddingResult.embedding,
                bEmbedding: embeddingResult.binaryEmbedding,
                bEmbeddingHash: embeddingResult.bEmbeddingHash,
              });
            } else {
              this.inferenceDB.processVerifiedConsensusEmbeddings({
                requestId: item.request.requestId,
                results: embeddingResults,
              });
            }
          } else {
            // TODO: Log an error?
            logger.error(
              "Could not inference ",
              item,
              " for unknown reason to caller"
            );
          }
        })
        .catch((err) => {
          // this.inferenceStatus.embeddingQueue =
          //   this.inferenceStatus.embeddingQueue.filter(
          //     (item) => item !== validInferenceResults[i]
          //   );

          logger.error("Error embedding ", item, " - ", err);
        });
    }
  }

  private processInferenceRequestQueue = debounce(
    () => {
      const cycleId = generateRandomString(3);

      const availableInferenceRequests =
        this.inferenceDB.activeInferenceRequests.filter(
          (inferenceRequest) =>
            inferenceRequest.endingAt > new Date() &&
            !this.inferenceStatus.inferenceIdsInProcess.includes(
              inferenceRequest.requestId
            )
        );

      logger.debug(
        "Request Inference Queue: ",
        cycleId,
        ": Found ",
        availableInferenceRequests.length,
        " available inference requests."
      );

      const neededModels = Array.from(
        new Set(
          availableInferenceRequests
            .map((inferenceRequest) => inferenceRequest.payload.acceptedModels)
            .flat()
        )
      );

      logger.debug(
        "Request Inference Queue: ",
        cycleId,
        ": Models needed - ",
        neededModels
      );

      const llmWorkerAvailability =
        this.llmEngine.getWorkerAvailability(neededModels);

      logger.debug(cycleId, ": Worker availability - ", llmWorkerAvailability);

      const possibleInferences = availableInferenceRequests.filter(
        (inferenceRequest) =>
          inferenceRequest.payload.acceptedModels.some(
            (model) =>
              llmWorkerAvailability[model] &&
              llmWorkerAvailability[model].free > 0
          )
      );

      logger.debug(
        "Request Inference Queue: ",
        cycleId,
        ": Possible inferences - ",
        possibleInferences
      );

      if (!possibleInferences.length) {
        logger.debug(cycleId, ": No possible inferences, going back to sleep.");
        return;
      }

      const selectedInference = possibleInferences.sort((a, b) => {
        return b.endingAt.getTime() - a.endingAt.getTime();
      })[0];

      logger.debug(
        "Request Inference Queue: ",
        cycleId,
        ": Selected inference - ",
        selectedInference.requestId
      );

      this.inferenceStatus.inferenceIdsInProcess.push(
        selectedInference.requestId
      );

      const inferenceStartedAt = new Date();

      this.packetDB.transmitPacket({
        type: "peerStatusUpdate",
        status: "inferencing",
        modelName: selectedInference.payload.acceptedModels[0],
        createdAt: stringifyDateWithOffset(new Date()),
      });

      this.llmEngine
        .runInferenceNonStreaming({
          modelName: selectedInference.payload.acceptedModels[0],
          messages: [
            { role: "user", content: selectedInference.payload.prompt },
          ],
        })
        .then((response) => {
          logger.debug(
            "Request Inference Queue: ",
            cycleId,
            ": Inference completed for ",
            selectedInference.requestId,
            " - ",
            response
          );

          const inferenceEndedAt = new Date();

          if (response.success) {
            const inferenceSeconds =
              inferenceEndedAt.getTime() / 1000 -
              inferenceStartedAt.getTime() / 1000;
            const tps =
              response.tokenCount && inferenceSeconds
                ? response.tokenCount / inferenceSeconds
                : 0;

            this.packetDB.transmitPacket({
              type: "peerStatusUpdate",
              status: "completed_inference",
              modelName: selectedInference.payload.acceptedModels[0],
              tps,
              createdAt: stringifyDateWithOffset(new Date()),
            });
          }

          return this.inferenceDB.saveInferenceResult({
            requestId: selectedInference.requestId,
            inferenceId:
              selectedInference.requestId + "." + generateRandomString(),
            startedAt: stringifyDateWithOffset(inferenceStartedAt),
            completedAt: stringifyDateWithOffset(new Date()),
            result: response,
          });
        })
        .then(() => {
          this.inferenceStatus.inferenceIdsInProcess =
            this.inferenceStatus.inferenceIdsInProcess.filter(
              (id) => id !== selectedInference.requestId
            );
        })
        .catch((err) => {
          logger.error(cycleId, ": Error running inference - ", err);

          return this.inferenceDB.saveInferenceResult({
            requestId: selectedInference.requestId,
            inferenceId:
              selectedInference.requestId + "." + generateRandomString(),
            startedAt: stringifyDateWithOffset(inferenceStartedAt),
            completedAt: stringifyDateWithOffset(new Date()),
            result: {
              success: false,
              error: err,
            },
          });
        });

      logger.debug(
        "Request Inference Queue: ",
        "looking for next inference, waiting a tick."
      );
      setTimeout(() => this.processInferenceRequestQueue(), 0);
    },
    THEDOMAIN_SETTINGS.inferenceRequestQueueDebounceMs,
    { leading: true }
  );

  // TODOs:
  // 1. Register error handlers for the p2p networks, and restart them (some finite number of times) if they error out
  // 2. Expose a packet subscriber to the outside in case someone wants to listen in

  async shutdownDomain() {
    for (const listener of this.shutdownListeners) {
      listener();
    }
  }

  public static async bootup({
    identityPassword,
    overwriteIdentity,
    initialEmbeddingWorkers,
    initialLLMWorkers,
  }: DomainStartOptions) {
    if (TheDomain.instance) return TheDomain.instance;

    logger.debug("Booting up the the domain...");

    // Initialize client info
    // TODO: We probably want things to emit events we can save to the logs
    const clientInfo = await initClientInfo(
      identityPassword,
      overwriteIdentity
    );

    logger.debug("Identity retrieved/created successfully.");

    const p2pNetworkInstances: P2PNetworkInstance<any, any>[] =
      THEDOMAIN_SETTINGS.enabledP2PNetworks.map((network) =>
        P2PNetworkFactory.createP2PNetworkInstance(
          network,
          clientInfo.synthientId
        )
      );

    logger.debug("Initialized p2p networks, waiting for bootup...");

    const workingP2PNetworkInstances =
      await P2PNetworkFactory.initializeP2PNetworks(
        p2pNetworkInstances,
        THEDOMAIN_SETTINGS.waitForP2PBootupMs
      );

    logger.debug("Connecting up working networks.");

    this.instance = new TheDomain(
      clientInfo,
      workingP2PNetworkInstances,
      initialEmbeddingWorkers,
      initialLLMWorkers
    );

    return this.instance;
  }
}
