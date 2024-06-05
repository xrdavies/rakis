import { EmbeddingEngine } from "../../embeddings/embedding-engine";
import { EmbeddingModelName } from "../../embeddings/types";
import { LLMEngine } from "../../llm/llm-engine";
import { LLMModelName } from "../../llm/types";
import { GUNDB_CONFIG, NKN_CONFIG, TRYSTERO_CONFIG } from "../config";
import {
  P2PDeliveryNetworks,
  SupportedP2PDeliveryNetwork,
} from "../db/entities";
import { InferenceDB } from "../db/inferencedb";
import { InferenceRequest, TransmittedPeerPacket } from "../db/packet-types";
import { PacketDB } from "../db/packetdb";
import { PeerDB } from "../db/peerdb";
import { ClientInfo, initClientInfo } from "../identity";
import { NknP2PNetworkInstance } from "../p2p-networks/nkn";
import { P2PNetworkInstance } from "../p2p-networks/p2pnetwork-types";
import { GunP2PNetworkInstance } from "../p2p-networks/pewpewdb";
import { TrysteroP2PNetworkInstance } from "../p2p-networks/trystero";
import {
  generateRandomString,
  stringifyDateWithOffset,
  timeoutPromise,
} from "../utils/utils";
import { THEDOMAIN_SETTINGS } from "./settings";

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
  private peerDB: PeerDB;
  private shutdownListeners: (() => void)[] = [];
  private embeddingEngine: EmbeddingEngine;
  private llmEngine: LLMEngine;
  private inferenceDB: InferenceDB;
  private inferenceStatus: {
    inferenceIdsInProcess: string[];
    inferenceCompletionInterval: NodeJS.Timeout | null;
    waitingForWorker: boolean;
  } = {
    inferenceIdsInProcess: [],
    inferenceCompletionInterval: null,
    waitingForWorker: false,
  };
  // private inferenceIdsInProcess: string[] = [];
  // private inferenceCompletionInterval: NodeJS.Timeout | null = null;
  private inferenceRequestSubscription: null | (() => void) = null;

  private constructor(
    private clientInfo: ClientInfo,
    private p2pNetworkInstances: P2PNetworkInstance<any, any>[],
    initialEmbeddingWorkers: { modelName: EmbeddingModelName; count: number }[],
    initialLLMWorkers: { modelName: LLMModelName; count: number }[]
  ) {
    this.packetDB = new PacketDB(clientInfo, this.broadcastPacket);
    this.peerDB = new PeerDB();
    this.inferenceDB = new InferenceDB();

    console.log("Databases created.");
    this.connectP2PToPacketDB();
    this.connectPacketDBToPeerDB();

    this.embeddingEngine = new EmbeddingEngine();
    this.llmEngine = new LLMEngine();

    console.log("Starting workers...");

    const workerStartPromises: Promise<any>[] = [];
    for (const worker of initialEmbeddingWorkers) {
      workerStartPromises.push(
        this.updateEmbeddingWorkers(worker.modelName, worker.count)
      );
    }
    for (const worker of initialLLMWorkers) {
      workerStartPromises.push(
        this.updateLLMWorkers(worker.modelName, worker.count)
      );
    }

    this.updateInferenceSubscription();

    // this.inferenceStatus.inferenceCompletionInterval = setInterval(() => {
    //   this.checkAndRunInference();
    // });

    // Await the promise if we want to block, but we're fine without I think

    if (typeof window !== "undefined") {
      (window as any).theDomain = {
        logInference: (
          prompt: string,
          model: LLMModelName,
          maxTimeMs: number
        ) => {
          this.inferenceDB.saveInferenceRequest({
            payload: {
              fromChain: "eth",
              blockNumber: 0,
              createdAt: new Date(),
              prompt,
              acceptedModels: [model],
              temperature: 1,
              maxTokens: 2048,
              securityFrame: {
                quorum: 10,
                maxTimeMs,
                secDistance: 0.9,
                secPercentage: 0.5,
              },
            },
            fetchedAt: new Date(),
          });
        },
        updateLLMWorkers: (modelName: LLMModelName, count: number) => {
          this.updateLLMWorkers(modelName, count);
        },
        llmEngine: this.llmEngine,
      };

      console.log("Inference request function exposed.");
    }
  }

  private updateInferenceSubscription() {
    if (this.inferenceRequestSubscription) {
      this.inferenceRequestSubscription();
    }

    this.inferenceRequestSubscription = this.inferenceDB.subscribeToInferences(
      {
        endingAfter: new Date(),
        models: Array.from(
          new Set(
            Object.values(this.llmEngine.llmWorkers).map(
              (worker) => worker.modelName
            )
          )
        ),
      },
      (packet) => {
        // console.log("Starting new inference loop because of incoming packet.");
        setTimeout(() => this.checkAndRunInference(), 0);
        // this.checkAndRunInference();
      }
    );
  }

  checkAndRunInference() {
    console.log("Checking and running inference...");

    const llmWorkerAvailability = Object.values(
      this.llmEngine.llmWorkers
    ).reduce(
      (acc, cur) => {
        acc[cur.modelName] ??= {
          count: 0,
          free: 0,
        };

        acc[cur.modelName].count++;
        if (!cur.inferenceInProgress) acc[cur.modelName].free++;

        return acc;
      },
      {} as {
        [modelName: string]: {
          count: number;
          free: number;
        };
      }
    );

    console.log("LLM Worker availability: ", llmWorkerAvailability);

    const possibleInferences = this.inferenceDB.activeInferenceRequests.filter(
      (inferenceRequest) =>
        inferenceRequest.endingAt > new Date() &&
        inferenceRequest.payload.acceptedModels.some(
          (model) => llmWorkerAvailability[model].free > 0
        ) &&
        !this.inferenceStatus.inferenceIdsInProcess.includes(
          inferenceRequest.requestId
        )
    );

    console.log("Possible inferences: ", possibleInferences);

    // TODO: IMPORTANT
    // Key code for selecting which inference requests to prioritize goes here - for now we're just picking the ones that have the longest to go

    if (possibleInferences.length > 0) {
      const selectedInference = possibleInferences.sort((a, b) => {
        return b.endingAt.getTime() - a.endingAt.getTime();
      })[0];

      this.inferenceStatus.inferenceIdsInProcess.push(
        selectedInference.requestId
      );

      const possibleModelsToSelect =
        selectedInference.payload.acceptedModels.filter(
          (modelName) => llmWorkerAvailability[modelName].free > 0
        );

      const selectedModel =
        possibleModelsToSelect[
          Math.floor(Math.random() * possibleModelsToSelect.length)
        ];

      console.log(
        "Running inference request ",
        selectedInference.requestId,
        " on model ",
        selectedModel
      );

      const inferenceStartedAt = new Date();

      this.llmEngine
        .runInferenceNonStreaming({
          modelName: selectedModel,
          messages: [
            { role: "user", content: selectedInference.payload.prompt },
          ],
          // TODO: Drill temperature and other parameters through here
        })
        .then((response) => {
          console.log(
            "Inference completed for ",
            selectedInference.requestId,
            " - ",
            response
          );

          this.inferenceDB.saveInferenceResult({
            requestId: selectedInference.requestId,
            // TODO: Secure this more by using a hash
            inferenceId:
              selectedInference.requestId + "." + generateRandomString(),
            startedAt: stringifyDateWithOffset(inferenceStartedAt),
            completedAt: stringifyDateWithOffset(new Date()),
            result: response,
          });
        });
    }

    if (possibleInferences.length < 2) {
      const possibleInferencesIfWorkersWereFree =
        this.inferenceDB.activeInferenceRequests.filter(
          (inferenceRequest) =>
            inferenceRequest.endingAt > new Date() &&
            inferenceRequest.payload.acceptedModels.some(
              (model) => llmWorkerAvailability[model].count > 0
            ) &&
            !this.inferenceStatus.inferenceIdsInProcess.includes(
              inferenceRequest.requestId
            )
        );

      if (possibleInferencesIfWorkersWereFree.length > 0) {
        const workerPromises = Object.values(this.llmEngine.llmWorkers)
          .filter(
            (worker) => worker.inferenceInProgress && worker.inferencePromise
          )
          .map((worker) => worker.inferencePromise!.promise);

        if (workerPromises.length) {
          console.log("Running when workers are free");
          if (!this.inferenceStatus.waitingForWorker) {
            this.inferenceStatus.waitingForWorker = true;
            Promise.any(workerPromises).then(() => {
              this.inferenceStatus.waitingForWorker = false;
              console.log(
                "Running again because an actual worker promise completed"
              );
              setTimeout(() => this.checkAndRunInference(), 0);
            });
          }
        }
      } else {
        console.log(
          "No inferences left to run, leaving us on a timeout to be sure."
        );
        if (this.inferenceStatus.inferenceCompletionInterval)
          clearInterval(this.inferenceStatus.inferenceCompletionInterval);

        this.inferenceStatus.inferenceCompletionInterval = setInterval(() => {
          this.checkAndRunInference();
        }, 5000);
      }
    } else {
      setTimeout(() => this.checkAndRunInference(), 0);
    }
  }

  // TODOs:
  // 1. Register error handlers for the p2p networks, and restart them (some finite number of times) if they error out
  // 2. Expose a packet subscriber to the outside in case someone wants to listen in

  async updateEmbeddingWorkers(
    modelName: EmbeddingModelName,
    count: number,
    abruptKill: boolean = false
  ) {
    const numberOfExistingWorkers = Object.values(
      this.embeddingEngine.embeddingWorkers
    ).filter((worker) => worker.modelName === modelName).length;

    if (numberOfExistingWorkers === count) return;

    if (numberOfExistingWorkers < count) {
      console.log(
        "Scaling up number of embedding workers for ",
        modelName,
        " to ",
        count
      );
      for (let i = 0; i < count - numberOfExistingWorkers; i++) {
        const workerId = `embedding-${modelName}-${generateRandomString()}`;
        this.embeddingEngine.addEmbeddingWorker(modelName, workerId);
      }
    } else {
      console.log(
        "Scaling down number of embedding workers for ",
        modelName,
        " to ",
        count
      );

      const workerIdsByLoad = Object.keys(
        this.embeddingEngine.embeddingWorkers
      ).sort((a, b) =>
        this.embeddingEngine.embeddingWorkers[a].busy ===
        this.embeddingEngine.embeddingWorkers[b].busy
          ? 0
          : this.embeddingEngine.embeddingWorkers[a].busy
          ? -1
          : 1
      );

      const workerIdsToScaleDown = workerIdsByLoad.slice(
        0,
        numberOfExistingWorkers - count
      );

      for (const workerId of workerIdsToScaleDown) {
        this.embeddingEngine.deleteEmbeddingWorker(workerId);
      }
    }
  }

  async updateLLMWorkers(
    modelName: LLMModelName,
    count: number,
    abruptKill: boolean = false
  ) {
    try {
      const numberOfExistingWorkers = Object.values(
        this.llmEngine.llmWorkers
      ).filter((worker) => worker.modelName === modelName).length;

      if (numberOfExistingWorkers === count) return;

      if (numberOfExistingWorkers < count) {
        console.log(
          "Scaling up number of llm workers for ",
          modelName,
          " to ",
          count
        );
        const scaleUpPromises: Promise<any>[] = [];
        for (let i = 0; i < count - numberOfExistingWorkers; i++) {
          const workerId = `llm-${modelName}-${generateRandomString()}`;
          scaleUpPromises.push(this.llmEngine.loadWorker(modelName, workerId));
        }

        // TODO: Process errors
      } else {
        console.log(
          "Scaling down number of llm workers for ",
          modelName,
          " to ",
          count
        );

        const workerIdsByLoad = Object.keys(this.llmEngine.llmWorkers).sort(
          (a, b) =>
            this.llmEngine.llmWorkers[a].inferenceInProgress ===
            this.llmEngine.llmWorkers[b].inferenceInProgress
              ? 0
              : this.llmEngine.llmWorkers[a].inferenceInProgress
              ? -1
              : 1
        );

        const workerIdsToScaleDown = workerIdsByLoad.slice(
          0,
          numberOfExistingWorkers - count
        );

        const scaleDownPromises: Promise<any>[] = [];
        for (const workerId of workerIdsToScaleDown) {
          scaleDownPromises.push(
            this.llmEngine.unloadWorker(workerId, abruptKill)
          );
        }

        // TODO: Process errors
      }
    } catch (err) {
      console.error("Domain: Error updating LLM workers", err);
    }

    this.updateInferenceSubscription();
  }

  private connectP2PToPacketDB() {
    for (const p2pNetwork of this.p2pNetworkInstances) {
      const listener = p2pNetwork.listenForPacket(async (packet) => {
        await this.packetDB.receivePacket(packet);
      });

      this.shutdownListeners.push(() => listener());
    }
  }

  private connectPacketDBToPeerDB() {
    const listener = this.packetDB.subscribeToNewPackets(
      {
        receivedTimeAfter: new Date(),
      },
      (packet) => {
        console.log("Processing packet for peerdb ", packet);
        this.peerDB.processPacket(packet);
      }
    );

    this.shutdownListeners.push(() => listener());
  }

  private async broadcastPacket(packet: TransmittedPeerPacket): Promise<void> {
    await Promise.all(
      this.p2pNetworkInstances.map((p) => p.broadcastPacket(packet))
    );
  }

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

    console.log("Booting up the the domain...");

    // Initialize client info

    // TODO: We probably want things to emit events we can save to the logs
    const clientInfo = await initClientInfo(
      identityPassword,
      overwriteIdentity
    );

    console.log("Identity retrieved/created successfully.");

    const p2pNetworkInstances: P2PNetworkInstance<any, any>[] = [];

    for (const network of P2PDeliveryNetworks) {
      if (THEDOMAIN_SETTINGS.enabledP2PNetworks.includes(network)) {
        console.log("Loading ", network, " network...");
        switch (network as SupportedP2PDeliveryNetwork) {
          case "gun":
            console.log("Initializing pewpewdb...");
            p2pNetworkInstances.push(
              new GunP2PNetworkInstance(clientInfo.synthientId, {
                gunPeers: GUNDB_CONFIG.bootstrapPeers,
                gunTopic: GUNDB_CONFIG.topic,
                startupDelayMs: GUNDB_CONFIG.bootFixedDelayMs,
              })
            );
            break;
          case "nkn":
            p2pNetworkInstances.push(
              new NknP2PNetworkInstance(clientInfo.synthientId, {
                nknTopic: NKN_CONFIG.topic,
                nknWalletPassword: "password",
              })
            );
            break;
          case "nostr":
            p2pNetworkInstances.push(
              new TrysteroP2PNetworkInstance(clientInfo.synthientId, {
                relayRedundancy: TRYSTERO_CONFIG.relayRedundancy,
                rtcConfig: TRYSTERO_CONFIG.rtcConfig,
                trysteroTopic: TRYSTERO_CONFIG.topic,
                trysteroAppId: TRYSTERO_CONFIG.appId,
                trysteroType: "nostr",
              })
            );
            break;
          case "torrent":
            p2pNetworkInstances.push(
              new TrysteroP2PNetworkInstance(clientInfo.synthientId, {
                relayRedundancy: TRYSTERO_CONFIG.relayRedundancy,
                rtcConfig: TRYSTERO_CONFIG.rtcConfig,
                trysteroTopic: TRYSTERO_CONFIG.topic,
                trysteroAppId: TRYSTERO_CONFIG.appId,
                trysteroType: "torrent",
              })
            );
            break;
          case "waku":
            console.log(
              "Waku attempted to load, but left unimplemented due to complexity and size."
            );
            break;
        }
      }
    }

    console.log("Initialized p2p networks, waiting for bootup...");

    const p2pLoadingResults: boolean[] = p2pNetworkInstances.map((p) => false);

    const waitingResult = await Promise.race([
      timeoutPromise(THEDOMAIN_SETTINGS.waitForP2PBootupMs),
      Promise.all(
        p2pNetworkInstances.map((p, index) =>
          p.waitForReady().then(() => (p2pLoadingResults[index] = true))
        )
      ),
    ]);

    if (waitingResult === "timeout") {
      console.log("Timed out waiting for all networks to load.");
      const unloadedNetworks = p2pNetworkInstances.filter(
        (_, index) => !p2pLoadingResults[index]
      );

      if (unloadedNetworks.length >= p2pNetworkInstances.length) {
        throw new Error(
          "No p2p networks could be loaded in time. Please check logs for errors."
        );
      }
    }

    console.log("Connecting up working networks.");

    this.instance = new TheDomain(
      clientInfo,
      p2pNetworkInstances.filter((_, index) => p2pLoadingResults[index]),
      initialEmbeddingWorkers,
      initialLLMWorkers
    );

    return this.instance;
  }
}
