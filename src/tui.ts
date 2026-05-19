import { confirm as clackConfirm, isCancel, select, text } from "@clack/prompts";

type MenuValue = string | number | boolean;

export interface MenuOption<T extends MenuValue> {
  label: string;
  value: T;
  hint?: string;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "PromptCancelledError";
  }
}

export function isPromptCancelledError(error: unknown): error is PromptCancelledError {
  return error instanceof PromptCancelledError;
}

function unwrapPrompt<T>(result: T | symbol): T {
  if (isCancel(result)) throw new PromptCancelledError();
  return result;
}

export async function ask(question: string, fallback = ""): Promise<string> {
  const answer = unwrapPrompt(
    await text(
      fallback
        ? {
            message: question,
            defaultValue: fallback,
            placeholder: fallback
          }
        : {
            message: question
          }
    )
  );
  const trimmed = answer.trim();
  return trimmed || fallback;
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = await clackConfirm({
    message: question,
    initialValue: fallback,
    active: "Yes",
    inactive: "No"
  });
  if (isCancel(answer)) return false;
  return answer;
}

export async function selectMenu<T extends MenuValue>(
  title: string,
  options: MenuOption<T>[],
  initialIndex = 0
): Promise<T | undefined> {
  const initialOption = options[Math.max(0, Math.min(initialIndex, options.length - 1))];
  const selection = (await select({
    message: title,
    ...(initialOption ? { initialValue: initialOption.value } : {}),
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {})
    }))
  } as never)) as T | symbol;
  if (isCancel(selection)) return undefined;
  return selection;
}
