/**
 * Linear GraphQL `IssueCreate` mutation の薄いラッパー（元: linear-client.ts）。
 *
 * graceful: あらゆる失敗（ネットワーク・teamId 欠落・GraphQL success:false）で
 * `null` を返す。呼び出し側は「実在する Linear issue なしにタスクを synced に
 * しない」ため、null を sync 失敗として扱う。
 *
 * 汎用化: fetch を注入可能にした（既定 globalThis.fetch）。
 */
import type { FetchLike } from "./types";

export interface LinearIssueInput {
  apiKey: string;
  teamId: string;
  title: string;
  description: string;
  labelIds?: string[];
}

export interface LinearIssue {
  id: string;
  url: string;
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_REQUEST_TIMEOUT_MS = 10_000;
const MAX_LINEAR_TITLE_LENGTH = 255;
const MAX_LINEAR_DESCRIPTION_LENGTH = 8_000;

const ISSUE_CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      url
    }
  }
}`;

interface IssueCreateResponse {
  data?: {
    issueCreate?: {
      success?: boolean;
      issue?: { id?: string; identifier?: string; url?: string };
    };
  };
  errors?: Array<{ message: string }>;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  if (typeof (timeout as { unref?: () => void }).unref === "function") {
    (timeout as unknown as { unref: () => void }).unref();
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timeout) };
}

export async function createLinearIssue(
  input: LinearIssueInput,
  fetchImpl: FetchLike = fetch,
): Promise<LinearIssue | null> {
  if (!input.apiKey || !input.teamId) return null;
  if (!input.title.trim()) return null;

  const timeout = createTimeoutSignal(LINEAR_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: input.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: ISSUE_CREATE_MUTATION,
        variables: {
          input: {
            teamId: input.teamId,
            title: truncate(input.title, MAX_LINEAR_TITLE_LENGTH),
            description: truncate(input.description, MAX_LINEAR_DESCRIPTION_LENGTH),
            labelIds: input.labelIds ?? [],
          },
        },
      }),
      signal: timeout.signal,
    });

    if (!res.ok) {
      return null;
    }

    const json = (await res.json()) as IssueCreateResponse;
    if (json.errors && json.errors.length > 0) {
      return null;
    }
    const issue = json.data?.issueCreate;
    if (!issue?.success || !issue.issue?.identifier || !issue.issue.url) {
      return null;
    }
    return { id: issue.issue.identifier, url: issue.issue.url };
  } catch {
    return null;
  } finally {
    timeout.cleanup();
  }
}
