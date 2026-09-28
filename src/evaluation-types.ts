import type { EntryType, Question, Usage } from "@typesafe-ai/sdk";
import type { BackendName } from "./backend.js";

export type QuestionMap = Record<string, Question>;
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, EntryType>;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface SystemOneEnvelope {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}
export interface EvalResult extends SystemOneEnvelope {
  ms: number;
  cached: boolean;
  backend?: BackendName;
  requestedModel?: string;
}
