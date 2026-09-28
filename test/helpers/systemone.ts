import type { Fetch } from "@typesafe-ai/sdk";
import type { QuestionMap, SystemOneEnvelope, Answer } from "../../src/evaluation-types.js";

export function makeEnvelope(questions: QuestionMap, model = "jev-1.13.0"): SystemOneEnvelope {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
    else if (question.type === "choice") {
      const labels = Object.keys(question.criteria);
      answers[id] = { type: "choice", choice: labels[0]!, confidence: 0.8,
        probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 0.8 : 0.2])) };
    } else {
      const levels = question.criteria.map((_, i) => String(i));
      answers[id] = { type: "score", score: 0.7, confidence: 0.2,
        legend: Object.fromEntries(levels.map((level, i) => [level, question.criteria[i]])),
        probabilities: Object.fromEntries(levels.map((level, i) => [level, i === 0 ? 0.3 : 0.7])) };
    }
  }
  return { model, answers, usage: { input_tokens: 100, output_tokens: 10 } };
}

export function scriptedFetch(responses: Array<Response | Error>): {
  fetch: Fetch; requests: Array<{ url: string; init: RequestInit }>;
} {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, init: init ?? {} });
    const response = responses.shift();
    if (!response) throw new Error("Unscripted fetch attempt");
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, requests };
}
