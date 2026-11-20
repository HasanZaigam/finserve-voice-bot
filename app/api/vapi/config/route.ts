import { NextResponse } from "next/server";
import { AGENT_NAME, BRAND, GREETING, voiceSystem } from "../../../../lib/prompt";
import { nowISTLabel, PURPOSES } from "../../../../lib/state";

export const dynamic = "force-dynamic";

/**
 * Voice is configurable from env, so you can try voices from the Vapi voice
 * library without code changes:
 *   VAPI_VOICE_PROVIDER = vapi | 11labs | cartesia
 *   VAPI_VOICE_ID       = voice name (vapi) or voice id (11labs / cartesia)
 *   VAPI_VOICE_MODEL    = optional model override
 */
function buildVoice() {
  const provider = process.env.VAPI_VOICE_PROVIDER || "vapi";
  const voiceId = process.env.VAPI_VOICE_ID;
  if (provider === "11labs" && voiceId) {
    return {
      provider: "11labs",
      voiceId,
      model: process.env.VAPI_VOICE_MODEL || "eleven_flash_v2_5",
      stability: 0.45,
      similarityBoost: 0.8,
      style: 0.2,
      useSpeakerBoost: true,
    };
  }
  if (provider === "cartesia" && voiceId) {
    return { provider: "cartesia", voiceId, model: process.env.VAPI_VOICE_MODEL || "sonic-3" };
  }
  return { provider: "vapi", voiceId: voiceId || "Rohan", speed: 1.0 };
}

/**
 * Returns a transient Vapi assistant. The browser starts the call with it, so
 * the prompt, voice and tools live in this repo instead of the Vapi dashboard.
 */
export async function GET(req: Request) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = host?.startsWith("localhost") ? "http" : "https";
  const toolUrl = process.env.PUBLIC_APP_URL
    ? `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/api/vapi/tools`
    : `${proto}://${host}/api/vapi/tools`;

  const server = { url: toolUrl, timeoutSeconds: 20 };

  const assistant = {
    name: `${BRAND} - ${AGENT_NAME}`,
    firstMessage: GREETING,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "anthropic",
      model: process.env.VAPI_MODEL || "claude-haiku-5-5",
      reasoningEffort: "none",
      temperature: 0.3,
      maxTokens: 400,
      messages: [{ role: "system", content: voiceSystem(nowISTLabel()) }],
      tools: [
        {
          type: "function",
          function: {
            name: "check_details",
            description:
              "Validate and record caller details. Call it whenever the caller gives their name, mobile number, email or the purpose of the call. Returns the normalised value and how to read it back, or an error to explain to the caller.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", description: "Caller's full name" },
                phone: { type: "string", description: "Mobile number exactly as heard, digits only" },
                email: { type: "string", description: "Email exactly as heard. Do not add .com if they didn't say it." },
                purpose: { type: "string", enum: PURPOSES },
              },
            },
          },
          server,
        },
        {
          type: "function",
          function: {
            name: "check_availability",
            description:
              "Check a callback date (and optionally a time) against calling hours and the specialists' calendar. Returns free slots or why it's not possible.",
            parameters: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD" },
                time: { type: "string", description: "HH:MM 24-hour, optional" },
              },
              required: ["date"],
            },
          },
          server,
        },
        {
          type: "function",
          function: {
            name: "book_callback",
            description:
              "Book the callback with a human specialist. Only call after the caller confirmed phone, email, and agreed to the recap.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string" },
                phone: { type: "string" },
                email: { type: "string" },
                purpose: { type: "string", enum: PURPOSES },
                details: {
                  type: "string",
                  description: "Answers to the follow-up questions, e.g. 'loan type: two-wheeler; amount: 1 lakh; employment: salaried'",
                },
                date: { type: "string", description: "YYYY-MM-DD" },
                time: { type: "string", description: "HH:MM 24-hour" },
                handover_note: {
                  type: "string",
                  description: "One sentence for the specialist: what the caller needs and anything urgent",
                },
              },
              required: ["name", "phone", "email", "purpose", "date", "time", "handover_note"],
            },
          },
          server,
        },
        { type: "endCall" },
      ],
    },
    voice: buildVoice(),
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    // Clean line by default; set VAPI_BACKGROUND=office for call-centre ambience.
    backgroundSound: process.env.VAPI_BACKGROUND || "off",
    // Natural turn-taking: wait for the caller to really finish, and don't stop
    // talking on a cough or a one-word "hmm".
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: "livekit" } },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 1 },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    endCallMessage: `Thank you for calling ${BRAND}. Have a great day!`,
    clientMessages: [
      "transcript",
      "tool-calls",
      "tool-calls-result",
      "conversation-update",
      "speech-update",
      "status-update",
    ],
  };

  return NextResponse.json({ assistant });
}
