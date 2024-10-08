import { EmbeddingModelName } from "../embeddings/types";
import { LLMModelName } from "../llm/types";
import { ChainIdentity, SupportedP2PDeliveryNetwork } from "./entities";

// Things from chain to client

export type InferenceResultAttributes = {
  requestId: string;
  inferenceId: string;
  startedAt: string; // timezoned date
  completedAt: string; // timezoned date
};

export type InferenceSuccessResult = InferenceResultAttributes & {
  result: InferenceSuccessPayload;
};

export type InferenceErrorResult = InferenceResultAttributes & {
  result: InferenceErrorPayload;
};

export type InferenceEmbedding = {
  inferenceId: string;
  requestId: string;
  embedding: number[];
  bEmbedding: number[];
  bEmbeddingHash: string;
};

export type InferenceResult = InferenceResultAttributes & {
  result: InferencePayload;
};

export type InferenceSuccessPayload = {
  success: true;
  result: string;
  tokenCount: number;
};
export type InferenceErrorPayload = {
  success: false;
  error: any;
};

export type InferencePayload = InferenceSuccessPayload | InferenceErrorPayload;

export type InferenceRequest = Required<UnprocessedInferenceRequest>;

export type UnprocessedInferenceRequest = {
  fromSynthientId: string;
  requestId?: string; // Could just be a hash of known-to-be-unique values
  payload: InferenceRequestPayload;
  endingAt?: Date; // Computed from the securityframe
  fetchedAt: Date;
};

export type InferenceRequestPayload = {
  fromChain: string;
  chainId?: number;
  txHash?: string;
  fromAccount?: string;
  blockNumber: number;
  createdAt: string;
  prompt: string;
  acceptedModels: LLMModelName[];
  temperature: number;
  maxTokens: number;
  securityFrame: InferenceSecurityFrame;
};

export type InferenceSecurityFrame = {
  quorum: number; // Number of inferences that need to happen for a quorum
  maxTimeMs: number; // Max amount of time that this round can take before failed inference
  secDistance: number; // Distance in embeddingspace
  secPercentage: number; // Percentage of quorum that needs to be within secDistance embedding distance
  embeddingModel: EmbeddingModelName;
};

// Unused for now, to set consensus thresholds and update those on the fly

// type NetworkHyperParameterUpdate = {
//   hyperParams: {
//     bEmbeddingVerificationThreshold: number; // Distance between computed binary embedding and revealed binary embedding that's acceptable
//     inferenceRevealTimeoutMs: number; // Time that reveal requests are valid for
//   };
//   hyperParamsMasterSignature: string; // Signature of the hyperParams by the master pubkey of the network
// };

// P2P Packets

export type ReceivedPeerPacket = TransmittedPeerPacket & {
  receivedTime?: Date; // Time that the packet was received, undefined if this was our own packet
  deliveredThrough?: SupportedP2PDeliveryNetwork; // The network that this packet was delivered through
};

export type TransmittedPeerPacket = {
  synthientId: string; // Public key identifying the peer
  signature: string; // Signature for this packet signed by the synthientId associated Private Key
  packet: PeerPacket;
};

export type PeerPacketAttributes = {
  createdAt: string;
};

export type PeerPacket =
  | PeerStatusUpdate
  | PeerHeart
  | PeerInfo
  | PeerConnectedChain
  | InferenceCommit
  | InferenceRevealRequest
  | KnownPeers
  | InferenceReveal
  | P2PInferenceRequestPacket
  | InferenceRevealRejected
  | InferenceQuorumComputed;

// TODO: These might be retired at some point, the intent here is just to test
// faster without costs of doing things on-chain
export type P2PInferenceRequestPacket = PeerPacketAttributes & {
  type: "p2pInferenceRequest";
  requestId: string;
  payload: InferenceRequestPayload;
};

type PeerStatusUpdate = PeerPacketAttributes &
  (
    | {
        status: "boot";
        totalTokens: number;
      }
    | {
        status: "loaded_worker";
        modelName: string;
        totalWorkers: number;
      }
    | {
        status: "inferencing";
        modelName: LLMModelName;
      }
    | {
        status: "completed_inference";
        tps: number;
        modelName: LLMModelName;
        totalTokens: number;
      }
    | {
        status: "computing_bEmbeddingHash";
        embeddingModels: EmbeddingModelName[];
      }
    | {
        status: "verifying quorum";
        requestId: string;
      }
  ) & {
    type: "peerStatusUpdate";
  };

export type KnownPeers = PeerPacketAttributes & {
  type: "knownPeers";
  peerList: {
    synthientId: string;
    identities?: ChainIdentity[];
    lastSeen: string;
    totalWorkers: number;
    seenOn: SupportedP2PDeliveryNetwork[];
    totalTokens: number;
  }[];
};

// This is just a silly way to send each other hearts or show liveness
// Removed the super fun hookup that we had ourt of worry it'll crash the network
export type PeerHeart = PeerPacketAttributes & {
  type: "peerHeart";
  windowX: number; // X coordinate of the window
  windowY: number;
};

type PeerInfo = PeerPacketAttributes & {
  type: "peerInfo";
  deviceInfo: string; // Some kind of signature of what kind of device they're on;
  // benchmarkResuts?: any; // To be defined, mostly about what kind of models they can run and at what TPS
};

export type PeerConnectedChain = PeerPacketAttributes & {
  type: "peerConnectedChain";
  identities: ChainIdentity[];
};

export const RequestIdPacketTypes = [
  "inferenceCommit",
  "inferenceRevealRequest",
  "inferenceReveal",
  "inferenceRevealRejected",
  "inferenceQuorumComputed",
] as const;

export type InferenceCommit = PeerPacketAttributes & {
  type: "inferenceCommit";
  bEmbeddingHash: string;
  requestId: string;
  inferenceId: string;
};

export type InferenceRevealRequest = PeerPacketAttributes & {
  type: "inferenceRevealRequest";
  // Request to reveal inferences within this fixed quorum
  requestId: string;
  quorum: {
    synthientId: string;
    inferenceId: string;
    bEmbeddingHash: string;
  }[];
  timeoutMs: number; // Time that this reveal request is valid to submit responses to
};

export type InferenceReveal = PeerPacketAttributes & {
  type: "inferenceReveal";
  requestedSynthientId: string; // For easier identification and to save some cpu cycles unpacking who this was for
  requestId: string;
  inferenceId: string;
  output: string;
  embedding: number[];
  bEmbedding: number[];
};

export type InferenceRevealRejected = PeerPacketAttributes & {
  type: "inferenceRevealRejected";
  requestId: string;
  inferenceId: string;
  rejectReason:
    | {
        type: "computed_bembedding_fails_threshold";
        computedBEmbedding: number[];
        revealedBEmbedding: number[];
      }
    | {
        type: "bembedding_hash_mismatch";
        revealedBEmbedding: number[];
        computedBEmbeddingHash: string;
        revealedBEmbeddingHash: string;
      };
};

export type InferenceQuorumComputed = PeerPacketAttributes & {
  type: "inferenceQuorumComputed";
  requestId: string;
  verifiedBy: string; // SynthientId of the peer that computed the quorum
  submittedInferences: {
    inferenceId: string;
  }[];
  validInferences: {
    inferenceId: string;
  }[];
  validInferenceJointHash: string; // Fixed deterministic hashing of the outputs - maybe just sort the inferences alphabetically and hash the results
  validSingleInference: {
    output: string;
    fromSynthientId: string;
    bEmbeddingHash: string;
  };
};
