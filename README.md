# FinServe AI Customer Care: Inbound Voice & Chat Bot

An AI customer-care agent for a fictional lender, **FinServe Finance**. A customer "calls" from the browser (real-time voice) or chats. The agent greets them, collects and **verifies** their details, asks follow-up questions based on why they're calling, checks the specialists' **Google Calendar** for a free slot, books a callback with a human loan specialist, and shows a confirmation with an AI-written handover note.

The use case mirrors AI-answered inbound calls in loan servicing and collections, with a human in the loop.

**Live demo:** https://finserve-voice-bot.vercel.app  ·  **Screen recording:** https://www.loom.com/share/8a475db84919411593baec8271be7290

---

## Features (mapped to the brief)

| Requirement | Implementation |
|---|---|
| Welcome message | Greeting with a call-recording disclosure, like a real contact centre |
| Data collection | Name, mobile, email, purpose. Each one is validated in code; mobile and email are **read back and confirmed** before they're saved |
| Conversational flow | Purpose-specific follow-ups: EMI query, payment arrangement, new loan, talk to an agent, other |
| Appointment scheduling | Natural-language date and time, checked against calling hours **and live calendar availability**; alternatives are offered if a slot is taken |
| Confirmation | Booking card with all details, a handover note for the specialist, "Add to my Google Calendar" and `.ics` |
| Error handling | Wrong digit count, incomplete email (never auto-completes `.com`), past or too-far dates ("did you mean 2026?"), out-of-hours times, vague answers, mis-hearings, corrections ("remove the last 4 digits"), API or mic failures |
| **Bonus:** AI API | Anthropic Claude (Haiku 5.5) for chat; Claude via Vapi for voice |
| **Bonus:** voice / call centre | **Vapi** web call: natural voice, Deepgram speech-to-text, interruptions (barge-in), office background ambience, live transcript, end-call |
| **Bonus:** scheduling | **Google Calendar API**: free/busy check and real event creation on the specialists' calendar |

## Architecture

```
                  ┌───────────── Voice call ─────────────┐
Browser ── Vapi Web SDK ── Vapi (Deepgram STT → Claude → voice)
   │                                   │ tool calls
   │                                   ▼
   │                         /api/vapi/tools  ── validate ── Google Calendar
   │                         (check_details, check_availability, book_callback)
   │
   └── Chat ── /api/chat: 1) Claude extracts fields (forced tool call)
                          2) code validates + read-back state machine
                          3) calendar free/busy check
                          4) Claude writes the reply (with a guard-rail fallback)
                          5) on completion: handover note + calendar event
```

**Design principle: the LLM talks, code decides.** Claude handles language: it understands messy speech and replies naturally. Deterministic code owns correctness: validation, confirmation, what's still missing, slot availability and booking. The agent can't skip a field, invent an email domain, or "book" something the calendar didn't accept.

### Reliability fixes from testing
- **Empty or cut-off replies:** on newer Claude models, reasoning shares the output token budget. Thinking is disabled for replies, the token limit is raised, and every reply is checked; if it's empty or has no question, a deterministic next question is used.
- **Hallucinated values:** extraction is told never to fill in missing parts, and contact details require an explicit "yes" after read-back.
- **Corrections:** the last rejected value is remembered, so "remove the last 4 digits" works.

## Tech stack
Next.js 15 (App Router, TypeScript) · Anthropic Claude API · Vapi Web SDK (Deepgram nova-3, LiveKit smart endpointing, configurable Vapi / ElevenLabs / Cartesia voice) · Google Calendar API (service account) · Vercel. Built with Claude as the AI coding tool.

## Setup
```bash
npm install
cp .env.example .env.local   # fill in the keys
npm run dev
```
- **Vapi:** create an account at dashboard.vapi.ai and copy the **public** key. No dashboard assistant is needed; the assistant config is served by `/api/vapi/config`.
- **Google Calendar:** create a service account with the Calendar API enabled, create a calendar, share it with the service account ("Make changes to events"), and copy the Calendar ID.
- Voice tool calls need a public URL, so test voice on the Vercel deployment (or set `PUBLIC_APP_URL` to a tunnel).

## Project structure
```
app/page.tsx                 Call-centre UI: voice call, chat, live call record, booking card
app/api/chat/route.ts        Chat pipeline (extract → validate → calendar → reply)
app/api/vapi/config/route.ts Vapi assistant: prompt, voice, transcriber, tools
app/api/vapi/tools/route.ts  Tool webhook: check_details, check_availability, book_callback
lib/state.ts                 Validators, read-back state machine, fallback questions
lib/calendar.ts              Google Calendar free/busy + event creation
lib/prompt.ts                Greeting, purpose flows, chat and voice prompts
lib/ics.ts                   .ics and "Add to Google Calendar" links
```

## Next steps
- A real phone number (Vapi or Twilio) for true inbound PSTN calls
- Hindi / Hinglish support (multilingual transcriber and voice)
- CRM or database persistence, SMS/WhatsApp confirmation, and post-call analytics
- Sign the tool webhook with a Vapi credential
