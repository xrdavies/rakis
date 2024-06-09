import Dexie, { type DexieOptions } from "dexie";
import {
  InferenceCommit,
  InferenceEmbedding,
  InferenceRequest,
  InferenceResult,
  InferenceReveal,
  InferenceRevealRequest,
  InferenceSuccessResult,
  ReceivedPeerPacket,
  UnprocessedInferenceRequest,
} from "./packet-types";
import { sha256 } from "@noble/hashes/sha256";
import * as ed from "@noble/ed25519";
import { generateRandomString, stringifyDateWithOffset } from "../utils/utils";
import EventEmitter from "eventemitter3";
import { createLogger, logStyles } from "../utils/logger";
import { QuorumDB } from "./quorumdb";
import { QUORUM_SETTINGS } from "../thedomain/settings";
import { EmbeddingResult } from "../embeddings/types";
import {
  ConsensusResults,
  InferenceDBEvents,
  InferenceQuorum,
} from "./entities";

const logger = createLogger("InferenceDB", logStyles.databases.inferenceDB);

class InferenceEmbeddingDatabase extends Dexie {
  inferenceEmbeddings!: Dexie.Table<InferenceEmbedding, string>;

  constructor(options: DexieOptions = {}) {
    super("InferenceEmbeddingDB", options);
    this.version(1).stores({
      inferenceEmbeddings: "inferenceId, requestId, bEmbeddingHash",
    });
  }
}

class InferenceRequestDatabase extends Dexie {
  inferenceRequests!: Dexie.Table<InferenceRequest, string>;

  constructor(options: DexieOptions = {}) {
    super("InferenceRequestDB", options);
    this.version(1).stores({
      inferenceRequests:
        "requestId, fromChain, endingAt, payload.acceptedModels",
    });
  }
}

class InferenceResultDatabase extends Dexie {
  inferenceResults!: Dexie.Table<InferenceResult, string>;

  constructor(options: DexieOptions = {}) {
    super("InferenceResultDB", options);
    this.version(1).stores({
      inferenceResults: "inferenceId, requestId, startedAt, completedAt",
    });
  }
}

export class InferenceDB extends EventEmitter<InferenceDBEvents> {
  private inferenceRequestDb: InferenceRequestDatabase;
  private inferenceResultDb: InferenceResultDatabase;
  private inferenceEmbeddingDb: InferenceEmbeddingDatabase;
  public quorumDb: QuorumDB;
  // This should ideally be part of the db or a live query once the network is larger, has a chance of becoming problematic
  public activeInferenceRequests: InferenceRequest[] = [];
  private cleanupTimeout: NodeJS.Timeout | null = null;

  constructor(private mySynthientId: string, dbOptions: DexieOptions = {}) {
    super();
    this.inferenceRequestDb = new InferenceRequestDatabase(dbOptions);
    this.inferenceResultDb = new InferenceResultDatabase(dbOptions);
    this.inferenceEmbeddingDb = new InferenceEmbeddingDatabase(dbOptions);
    this.quorumDb = new QuorumDB(mySynthientId);

    this.quorumDb.on("requestReveal", (quorums) => {
      this.emitRevealRequests(quorums);
    });
  }

  async getInferences(lastN: number) {
    const lastInferenceRequests: InferenceRequest[] =
      await this.inferenceRequestDb.inferenceRequests
        .orderBy("endingAt")
        .reverse()
        .limit(lastN)
        .toArray();

    const matchingInferenceResults: InferenceResult[] =
      await this.inferenceResultDb.inferenceResults
        .where("requestId")
        .anyOf(lastInferenceRequests.map((request) => request.requestId))
        .toArray();

    const matchingInferenceEmbeddings: InferenceEmbedding[] =
      await this.inferenceEmbeddingDb.inferenceEmbeddings
        .where("requestId")
        .anyOf(lastInferenceRequests.map((request) => request.requestId))
        .toArray();

    const matchingQuorums: InferenceQuorum[] = await this.quorumDb.getQuorums(
      lastInferenceRequests.map((request) => request.requestId)
    );

    const matchingConsensusResults: ConsensusResults[] =
      await this.quorumDb.getConsensusResults(
        lastInferenceRequests.map((request) => request.requestId)
      );

    return lastInferenceRequests.map((request) => {
      const result = matchingInferenceResults.find(
        (result) => result.requestId === request.requestId
      );

      const embedding = matchingInferenceEmbeddings.find(
        (embedding) => embedding.requestId === request.requestId
      );

      const quorum = matchingQuorums.find(
        (quorum) => quorum.requestId === request.requestId
      );

      const consensusResult = matchingConsensusResults.find(
        (result) => result.requestId === request.requestId
      );

      return {
        requestId: request.requestId,
        requestedAt: request.payload.createdAt,
        endingAt: request.endingAt,
        requestPayload: request.payload,
        ourResult: result && {
          payload: result,
          bEmbeddingHash: embedding?.bEmbeddingHash,
        },
        quorum: quorum && {
          status: quorum.status,
          quorumThreshold: quorum.quorumThreshold,
          quorumCommitted: quorum.quorumCommitted,
          quorumRevealed: quorum.quorumRevealed,
          quorum: quorum.quorum.map((q) => ({
            inferenceId: q.inferenceId,
            synthientId: q.synthientId,
            commitReceivedAt: q.commitReceivedAt,
            bEmbeddingHash: q.bEmbeddingHash,
            reveal: q.reveal && {
              output: q.reveal.output,
              receivedAt: q.reveal.receivedAt,
            },
          })),
        },
        consensusResult: consensusResult && {
          status: consensusResult.reason,
          result: consensusResult.computedQuorumPacket && {
            submittedInferences:
              consensusResult.computedQuorumPacket.submittedInferences,
            validInferences:
              consensusResult.computedQuorumPacket.validInferences,
            validInferenceJointHash:
              consensusResult.computedQuorumPacket.validInferenceJointHash,
            validInference: {
              output:
                consensusResult.computedQuorumPacket.validSingleInference
                  .output,
              fromSynthientId:
                consensusResult.computedQuorumPacket.validSingleInference
                  .fromSynthientId,
              bEmbeddingHash:
                consensusResult.computedQuorumPacket.validSingleInference
                  .bEmbeddingHash,
            },
          },
        },
      };
    });
  }

  private emitRevealRequests(quorums: InferenceQuorum[]) {
    const revealPackets: InferenceRevealRequest[] = quorums.map((quorum) => ({
      createdAt: stringifyDateWithOffset(new Date()),
      type: "inferenceRevealRequest",
      requestId: quorum.requestId,
      quorum: quorum.quorum.map((inference) => ({
        inferenceId: inference.inferenceId,
        synthientId: inference.synthientId,
        bEmbeddingHash: inference.bEmbeddingHash,
      })),
      timeoutMs: QUORUM_SETTINGS.quorumRevealTimeoutMs,
    }));

    logger.debug("Emitting reveal requests ", revealPackets);

    this.emit("requestQuorumReveal", revealPackets);
  }

  private refreshCleanupTimeout() {
    if (this.cleanupTimeout) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }

    const now = new Date();

    this.activeInferenceRequests = this.activeInferenceRequests.filter(
      (inference) => inference.endingAt > now
    );

    if (!this.activeInferenceRequests.length) return;

    const inferencesSortedByTimeRemaining = this.activeInferenceRequests.sort(
      (a, b) => a.endingAt.getTime() - b.endingAt.getTime()
    );

    this.cleanupTimeout = setTimeout(() => {
      this.cleanupExpiredInferences();
    }, inferencesSortedByTimeRemaining[0].endingAt.getTime() - now.getTime());
  }

  private async cleanupExpiredInferences() {
    const now = new Date();

    const matchingResults = (
      await this.inferenceResultDb.inferenceResults
        .where("requestId")
        .anyOf(
          this.activeInferenceRequests.map((inference) => inference.requestId)
        )
        .toArray()
    ).map((result) => result.requestId);

    logger.debug("Got matching results ", matchingResults);

    this.activeInferenceRequests = this.activeInferenceRequests.filter(
      (inference) =>
        !(inference.endingAt <= now) &&
        !matchingResults.includes(inference.requestId)
    );

    logger.debug(
      "Active inferences after cleanup",
      this.activeInferenceRequests.length
    );

    if (this.activeInferenceRequests.length > 0) {
      this.refreshCleanupTimeout();
    }
  }

  async processInferenceReveal(
    revealPacket: Omit<ReceivedPeerPacket, "packet"> & {
      packet: InferenceReveal;
    }
  ) {
    // Find matching request in our db
    const matchingRequest = await this.inferenceRequestDb.inferenceRequests.get(
      revealPacket.packet.requestId
    );

    if (!matchingRequest) {
      logger.error(
        "No matching request for revealed inference, skipping ",
        revealPacket
      );
      return;
    }

    this.quorumDb.processInferenceReveal(revealPacket);
  }

  async processVerifiedConsensusEmbeddings(embeddingResults: {
    requestId: string;
    results: EmbeddingResult[] | false;
  }) {
    if (!embeddingResults.results) {
      logger.error(
        "No results to process for verified embeddings",
        embeddingResults
      );
      return;
    }

    const matchingRequest = await this.inferenceRequestDb.inferenceRequests.get(
      embeddingResults.requestId
    );

    if (!matchingRequest) {
      logger.error(
        "No matching request for verified embeddings to run final consensus",
        embeddingResults
      );
      return;
    }

    await this.quorumDb.processVerifiedConsensusEmbeddings(
      matchingRequest,
      embeddingResults.results
    );
  }

  async processInferenceRevealRequest(
    requestPacket: Omit<ReceivedPeerPacket, "packet"> & {
      packet: InferenceRevealRequest;
    }
  ) {
    // First validate by getting the request and checking the endingAt
    const matchingRequest = await this.inferenceRequestDb.inferenceRequests.get(
      requestPacket.packet.requestId
    );

    if (!matchingRequest) {
      logger.error("No matching request for reveal request ", requestPacket);
      return;
    }

    if (matchingRequest.endingAt > new Date()) {
      logger.error("Request is still active. Not revealing embeddings.");
      return;
    }

    const ourCommit = requestPacket.packet.quorum.find(
      (commit) => commit.synthientId === this.mySynthientId
    );

    if (!ourCommit) {
      logger.error("No matching commit with our synthient id ", requestPacket);
      return;
    }

    // Next check if we have the inferenceresult
    const matchingResult = await this.inferenceResultDb.inferenceResults.get(
      ourCommit.inferenceId
    );

    if (!matchingResult) {
      logger.error("No matching result for reveal request ", requestPacket);
      return;
    }

    if (!matchingResult.result.success) {
      logger.error("Result was not successful. Not revealing embeddings.");
      return;
    }

    const matchingEmbedding =
      await this.inferenceEmbeddingDb.inferenceEmbeddings.get(
        matchingResult.inferenceId
      );

    if (!matchingEmbedding) {
      logger.error("No matching embedding for reveal request ", requestPacket);
      return;
    }

    // Get the embeddings for the result

    logger.debug("Revealing our inference to ", requestPacket.synthientId);

    this.emit("revealedInference", {
      createdAt: stringifyDateWithOffset(new Date()),
      type: "inferenceReveal",
      requestedSynthientId: requestPacket.synthientId,
      requestId: matchingRequest.requestId,
      inferenceId: matchingResult.inferenceId,
      output: matchingResult.result.result,
      embedding: matchingEmbedding.embedding,
      bEmbedding: matchingEmbedding.bEmbedding,
    });
  }

  async saveInferenceEmbedding(
    inferenceResult: InferenceResult,
    inferenceEmbedding: InferenceEmbedding
  ) {
    // Check for matching inferenceResults
    const matchingResult = await this.inferenceResultDb.inferenceResults.get(
      inferenceResult.inferenceId
    );

    if (!matchingResult)
      throw new Error(
        `No matching inference result for embedding - ${inferenceResult.inferenceId}`
      );

    // Check for matching inferenceEmbeddings
    const existingEmbedding =
      await this.inferenceEmbeddingDb.inferenceEmbeddings.get(
        inferenceEmbedding.inferenceId
      );

    if (existingEmbedding) {
      logger.debug("Embedding already exists. Skipping save.");
      return;
    }

    await this.inferenceEmbeddingDb.inferenceEmbeddings.put(inferenceEmbedding);

    this.emit("newInferenceEmbedding", inferenceEmbedding);
  }

  async saveInferenceResult(inferenceResult: InferenceResult) {
    this.activeInferenceRequests = this.activeInferenceRequests.filter(
      (inference) => inference.requestId !== inferenceResult.requestId
    );

    await this.inferenceResultDb.inferenceResults.put(inferenceResult);

    if (inferenceResult.result.success) {
      // Get matching inferenceRequest and recheck
      const matchingRequest =
        await this.inferenceRequestDb.inferenceRequests.get(
          inferenceResult.requestId
        );

      if (matchingRequest && matchingRequest.endingAt > new Date()) {
        this.emit(
          "inferenceResultAwaitingEmbedding",
          matchingRequest,
          inferenceResult as InferenceSuccessResult
        );
      }
    }
  }

  async saveInferenceCommit(
    packet: Omit<ReceivedPeerPacket, "packet"> & { packet: InferenceCommit }
  ) {
    const matchingInferenceRequest =
      await this.inferenceRequestDb.inferenceRequests.get(
        packet.packet.requestId
      );

    if (!matchingInferenceRequest) {
      logger.error("No matching inference request for commit ", packet);
      return;
    }

    await this.quorumDb.processInferenceCommit(
      packet,
      matchingInferenceRequest
    );
  }

  async saveInferenceRequest(
    request: UnprocessedInferenceRequest
  ): Promise<void> {
    // Calculate a hash of the object values to use as the requestId
    const objectValues = Object.values(request.payload).join("");
    // TODO: Use a different source of randomness here, probably the txhash
    request.requestId ??=
      ed.etc.bytesToHex(sha256(objectValues)) + "." + generateRandomString(8);

    // Check if the request already exists in the database
    const existingRequest = await this.inferenceRequestDb.inferenceRequests.get(
      request.requestId
    );
    if (existingRequest) {
      logger.debug("Inference request already exists. Skipping save.");
      return;
    }

    // Calculate endingAt date from the securityFrame of the request
    const endingAt = new Date(
      new Date(request.payload.createdAt).getTime() +
        request.payload.securityFrame.maxTimeMs
    );
    request.endingAt = endingAt;

    const processedRequest: InferenceRequest = {
      ...request,
      endingAt,
      requestId: request.requestId!,
    };

    logger.debug("Saving ", processedRequest);

    // Save the request to the database
    await this.inferenceRequestDb.inferenceRequests.put(processedRequest);

    // Update the activeInferenceRequests array
    if (endingAt > new Date()) {
      this.activeInferenceRequests.push(processedRequest);

      logger.debug(
        "Active inferences after save",
        this.activeInferenceRequests.length
      );

      this.refreshCleanupTimeout();
    }

    // Notify subscribers of the new inference request
    // TODO: See if we can't make this an array, or just switch to
    // individual objects like in packetdb
    if (processedRequest.endingAt > new Date())
      setTimeout(
        () => this.emit("newActiveInferenceRequest", processedRequest),
        0
      );

    setTimeout(() => this.emit("newInferenceRequest", processedRequest), 0);
  }
}
