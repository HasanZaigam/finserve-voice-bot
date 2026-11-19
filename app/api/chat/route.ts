import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { extractSystem, replySystem, SUMMARY_SYSTEM } from "../../../lib/prompt";
import {
  BotState,
  emptyState,
  Extracted,
  mergeExtracted,
  missingFields,
  nowISTLabel,
} from "../../../lib/state";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

type Msg = { role: "user" | "assistant"; content: string };

const extractTool: Anthropic.Tool = {
  name: "update_customer_info",
  description:
    "Record customer details found in the customer's latest message. Include only fields the customer actually provided.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      purpose: {
        type: "string",
        enum: ["emi_query", "payment_plan", "new_loan", "talk_to_agent", "other"],
      },
      details: {
        type: "object",
        description: "Branch-specific answers with snake_case keys",
        additionalProperties: { type: "string" },
      },
      details_complete: { type: "boolean" },
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM, 24-hour" },
    },
  },
};

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages: Msg[] = Array.isArray(body.messages) ? body.messages : [];
    const prevState: BotState = body.state ?? emptyState();

    // The API needs the first message to come from the user; the greeting is ours.
    const apiMessages: Msg[] =
      messages[0]?.role === "assistant"
        ? [{ role: "user", content: "(call connected)" }, ...messages]
        : messages;

    const now = nowISTLabel();

    // 1) Extract: Claude turns free text into structured fields.
    const extraction = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: extractSystem(now, prevState),
      tools: [extractTool],
      tool_choice: { type: "tool", name: "update_customer_info" },
      messages: apiMessages,
    });
    const toolUse = extraction.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const extracted = (toolUse?.input ?? {}) as Extracted;

    // 2) Validate in code, merge into state.
    const { state, errors } = mergeExtracted(prevState, extracted);
    const missing = missingFields(state);
    const done = missing.length === 0;

    // 3) Reply: Claude phrases the next turn naturally.
    const replyRes = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: replySystem(now, state, errors, missing, done),
      messages: apiMessages,
    });
    const reply =
      textOf(replyRes) || "Sorry, could you please repeat that?";

    // 4) Handover note for the human agent once everything is collected.
    let summary = "";
    if (done) {
      const s = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: SUMMARY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Collected data:\n${JSON.stringify(state, null, 2)}\n\nTranscript:\n${messages
              .map((m) => `${m.role === "user" ? "Customer" : "Bot"}: ${m.content}`)
              .join("\n")}`,
          },
        ],
      });
      summary = textOf(s);
    }

    return NextResponse.json({ reply, state, done, summary, errors });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Something went wrong talking to the AI service." },
      { status: 500 },
    );
  }
}
