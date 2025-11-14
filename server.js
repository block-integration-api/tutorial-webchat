// server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;

// Store active status update streams (keyed by request ID)
const statusStreams = new Map();
// Store queued status messages (keyed by request ID)
const statusQueues = new Map();

// --- System prompt for the assistant ---

function getSystemPrompt() {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  const dateTime = now.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const defaultProvider = process.env.DEFAULT_PROVIDER_NAME || "";

  return `

You are an AI assistant embedded in a website chat widget.

You help users book appointments for a hair salon in California.

Current date and time: ${dateTime} (${dayOfWeek})

If customer does not specify a provider, use the default provider "${defaultProvider}".

You MUST:

- Ask clarifying questions to collect: name, phone, service, and desired date/time.
- Once you have enough information, call the "book_appointment" tool.
- After booking, clearly confirm the date/time and any confirmation details.
- If the phone number can be formatted properly, do it for the customer. If ambigous, ask the customer to clarify.

If the user asks questions unrelated to booking, answer them briefly and politely.

`;
}

// --- Tool definition: what the LLM "sees" ---

const TOOLS = [
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book an appointment for the user via the Block API. Use this once you have all required information.",
      parameters: {
        type: "object",
        properties: {
          provider_name: {
            type: "string",
            description: "Name of the provider booking the appointment.",
          },
          customer_name: {
            type: "string",
            description: "Full name of the customer.",
          },
          customer_phone: {
            type: "string",
            description:
              "Customer phone number in a format usable by the business, e.g. +1-555-555-5555.",
          },
          service_name: {
            type: "string",
            description: "The service being booked, e.g. 'haircut', 'AC repair'.",
          },
          start_time: {
            type: "string",
            description:
              "Requested appointment start time in ISO 8601 format, e.g. 2025-11-20T10:00:00-08:00.",
          },
          notes: {
            type: "string",
            description:
              "Optional free-text notes to send to the business (pet name, special instructions, etc.).",
          },
        },
        required: ["customer_name", "customer_phone", "service_name", "start_time", "provider_name"],
      },
    },
  },
];

// --- Helper: call Block API to book the appointment ---

async function bookAppointmentViaBlock(args, onStatusUpdate = null) {
  const baseUrl = process.env.BLOCK_API_BASE_URL;
  const apiKey = process.env.BLOCK_API_KEY;
  const connectionId = process.env.CONNECTION_ID;

  if (!baseUrl || !apiKey || !connectionId) {
    throw new Error(
      "BLOCK_API_BASE_URL, BLOCK_API_KEY, or CONNECTION_ID is not configured"
    );
  }

  // Split customer name into first and last name
  const nameParts = args.customer_name.trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  // Use default provider if not specified
  const providerName = args.provider_name?.trim() || process.env.DEFAULT_PROVIDER_NAME || "";

  // Prepare Block API request payload
  const blockPayload = {
    action: "BookAppointment",
    connectionId: connectionId,
    payload: {
      datetime: args.start_time,
      provider: providerName,
      service: args.service_name,
      customer: {
        firstName: firstName,
        lastName: lastName,
        phone: args.customer_phone,
      },
    },
  };

  // Add optional note if provided
  if (args.notes) {
    blockPayload.payload.note = args.notes;
  }

  // Step 1: Submit the action to Block API
  const actionsUrl = `${baseUrl}/v1/actions`;
  console.log("[bookAppointmentViaBlock] Submitting action to:", actionsUrl);
  console.log("[bookAppointmentViaBlock] Payload:", JSON.stringify(blockPayload, null, 2));

  let actionsRes;
  try {
    actionsRes = await fetch(actionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(blockPayload),
    });
  } catch (fetchError) {
    console.error("[bookAppointmentViaBlock] Fetch error:", fetchError);
    throw new Error(`Failed to connect to Block API: ${fetchError.message}`);
  }

  if (!actionsRes.ok) {
    const text = await actionsRes.text();
    console.error("[bookAppointmentViaBlock] Block API error response:", {
      status: actionsRes.status,
      statusText: actionsRes.statusText,
      body: text,
    });
    throw new Error(
      `Block API error (${actionsRes.status}): ${text || actionsRes.statusText}`
    );
  }

  let actionsData;
  try {
    actionsData = await actionsRes.json();
    console.log("[bookAppointmentViaBlock] Action submitted, response:", JSON.stringify(actionsData, null, 2));
  } catch (parseError) {
    console.error("[bookAppointmentViaBlock] Failed to parse response:", parseError);
    const text = await actionsRes.text();
    console.error("[bookAppointmentViaBlock] Raw response:", text);
    throw new Error(`Failed to parse Block API response: ${parseError.message}`);
  }

  const jobId = actionsData.jobId;

  if (!jobId) {
    console.error("[bookAppointmentViaBlock] No jobId in response:", actionsData);
    throw new Error("Block API did not return a jobId");
  }

  console.log("[bookAppointmentViaBlock] Job created, jobId:", jobId);

  // Step 2: Poll for job completion
  const jobsUrl = `${baseUrl}/v1/jobs/${jobId}`;
  const maxAttempts = 60; // 60 attempts
  const pollInterval = 2000; // 2 seconds between polls
  const timeout = maxAttempts * pollInterval; // 2 minutes total

  const startTime = Date.now();
  let attemptCount = 0;
  let lastProcessedTimestamp = null; // Track last processed event timestamp

  console.log("[bookAppointmentViaBlock] Starting to poll for job completion...");

  while (Date.now() - startTime < timeout) {
    attemptCount++;
    console.log(`[bookAppointmentViaBlock] Polling attempt ${attemptCount}, jobId: ${jobId}`);

    let jobRes;
    try {
      jobRes = await fetch(jobsUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
    } catch (fetchError) {
      console.error("[bookAppointmentViaBlock] Poll fetch error:", fetchError);
      throw new Error(`Failed to poll job status: ${fetchError.message}`);
    }

    if (!jobRes.ok) {
      const text = await jobRes.text();
      console.error("[bookAppointmentViaBlock] Job polling error response:", {
        status: jobRes.status,
        statusText: jobRes.statusText,
        body: text,
      });
      throw new Error(
        `Block API job polling error (${jobRes.status}): ${text || jobRes.statusText}`
      );
    }

    let jobData;
    try {
      jobData = await jobRes.json();
    } catch (parseError) {
      console.error("[bookAppointmentViaBlock] Failed to parse job response:", parseError);
      const text = await jobRes.text();
      console.error("[bookAppointmentViaBlock] Raw job response:", text);
      throw new Error(`Failed to parse job status response: ${parseError.message}`);
    }

    const status = jobData.status;
    console.log(`[bookAppointmentViaBlock] Job status: ${status}`, JSON.stringify(jobData, null, 2));

    // Extract and send new messages from recentEvents
    if (onStatusUpdate && jobData.recentEvents && jobData.recentEvents.length > 0) {
      // recentEvents are in chronological order (oldest first)
      for (const event of jobData.recentEvents) {
        const eventTimestamp = event.created_at;

        // Only process events we haven't seen yet
        if (eventTimestamp && (!lastProcessedTimestamp || eventTimestamp > lastProcessedTimestamp)) {
          if (event.message) {
            console.log(`[bookAppointmentViaBlock] Sending status update: ${event.message}`);
            onStatusUpdate(event.message);
          }
          // Update last processed timestamp (even if no message, to avoid reprocessing)
          lastProcessedTimestamp = eventTimestamp;
        }
      }
    }

    if (status === "success") {
      // Job completed successfully
      const result = jobData.result || {};
      console.log("[bookAppointmentViaBlock] Booking successful!", JSON.stringify(result, null, 2));

      // Don't close stream here - let the async handler send the final formatted message
      // The async function will handle closing the stream after sending the final message

      return {
        booking_id: result.appointmentId || jobId,
        start_time: args.start_time,
        service_name: args.service_name,
        customer_name: args.customer_name,
        status: "success",
        raw: jobData,
      };
    } else if (status === "error") {
      // Job failed
      const errorMessage =
        jobData.errorMessage || jobData.result?.error || "Unknown error";
      console.error("[bookAppointmentViaBlock] Booking failed:", errorMessage, JSON.stringify(jobData, null, 2));

      // Don't send error message here - let the async handler's catch block handle it
      // This prevents duplicate error messages and stream closing issues

      throw new Error(`Booking failed: ${errorMessage}`);
    }

    // Status is "queued" or "in_progress", wait and poll again
    console.log(`[bookAppointmentViaBlock] Job still ${status}, waiting ${pollInterval}ms before next poll...`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout reached
  const timeoutMessage = `Booking timed out after ${timeout / 1000} seconds`;
  console.error(`[bookAppointmentViaBlock] ${timeoutMessage}. Job ID: ${jobId}`);

  // Don't send error message here - let the async handler's catch block handle it
  // This prevents duplicate error messages and stream closing issues

  throw new Error(timeoutMessage);
}

// --- /api/status endpoint (SSE for job status updates) ---

app.get("/api/status/:requestId", (req, res) => {
  const requestId = req.params.requestId;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  let streamClosed = false;
  const sendStatus = (message) => {
    if (streamClosed) {
      console.warn(`[api/status] Attempted to send message to closed stream: ${message}`);
      return;
    }
    try {
      if (message === null) {
        // null signals completion - send close signal and end stream
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        streamClosed = true;
      } else {
        res.write(`data: ${JSON.stringify({ message })}\n\n`);
        // Flush to ensure message is sent immediately
        if (res.flush) {
          res.flush();
        }
      }
    } catch (e) {
      console.error(`[api/status] Error sending status: ${e.message}`);
      streamClosed = true;
    }
  };

  statusStreams.set(requestId, sendStatus);

  // Send any queued messages
  const queue = statusQueues.get(requestId) || [];
  console.log(`[api/status] Frontend connected, sending ${queue.length} queued messages`);
  queue.forEach(msg => {
    if (msg !== null) {
      sendStatus(msg);
    }
  });
  statusQueues.delete(requestId);

  req.on("close", () => {
    statusStreams.delete(requestId);
    statusQueues.delete(requestId);
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ message: "Connected" })}\n\n`);
});

// --- /api/chat endpoint ---

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing 'message' in request body" });
    }

    // History is an array of { role, content } from previous turns.
    const priorMessages = Array.isArray(history) ? history : [];

    const messages = [
      { role: "system", content: getSystemPrompt() },
      ...priorMessages,
      { role: "user", content: message },
    ];

    // 1) First call: let the model decide whether to call the tool

    const first = await openai.chat.completions.create({
      model: "gpt-4o-mini", // or any tool-capable model
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

    const assistantMessage = first.choices[0]?.message;

    if (!assistantMessage) {
      return res.status(500).json({ error: "No message returned from LLM" });
    }

    // If the model decided to call a tool, handle it:

    let finalAssistantMessage = assistantMessage;
    const toolCalls = assistantMessage.tool_calls || [];
    let bookingRequestId = null;

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const fn = toolCall.function;

        if (!fn) continue;

        if (fn.name === "book_appointment") {
          const args = JSON.parse(fn.arguments || "{}");
          console.log("[api/chat] Calling bookAppointmentViaBlock with args:", JSON.stringify(args, null, 2));

          // Generate request ID for status streaming
          bookingRequestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

          // Set up status update callback
          const onStatusUpdate = (message) => {
            const sendStatus = statusStreams.get(bookingRequestId);
            if (sendStatus) {
              console.log(`[api/chat] Sending status update to stream: ${message || '(close signal)'}`);
              sendStatus(message);
            } else {
              // Queue message if frontend hasn't connected yet
              console.log(`[api/chat] Queueing status update (frontend not connected): ${message || '(close signal)'}`);
              if (!statusQueues.has(bookingRequestId)) {
                statusQueues.set(bookingRequestId, []);
              }
              statusQueues.get(bookingRequestId).push(message);
            }
          };

          // Process booking asynchronously - don't await here!
          (async () => {
            try {
              const bookingResult = await bookAppointmentViaBlock(args, onStatusUpdate);
              console.log("[api/chat] Booking result:", JSON.stringify(bookingResult, null, 2));

              // Generate final assistant message with the booking result
              const toolMessages = [{
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify(bookingResult),
              }];

              const secondMessages = [
                ...messages,
                assistantMessage,
                ...toolMessages,
              ];

              const second = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: secondMessages,
              });

              const finalMessage = second.choices[0]?.message?.content || "Booking completed.";
              console.log("[api/chat] Generated final message:", finalMessage);

              // Send final message via SSE
              const sendStatus = statusStreams.get(bookingRequestId);
              if (sendStatus) {
                console.log("[api/chat] Sending final message via SSE");
                sendStatus(`final:${finalMessage}`);
                // Small delay before closing
                setTimeout(() => {
                  try {
                    console.log("[api/chat] Closing SSE stream");
                    sendStatus(null);
                  } catch (e) {
                    console.error("[api/chat] Error closing stream:", e);
                    // Ignore errors if stream is already closed
                  }
                }, 100);
              } else {
                console.warn("[api/chat] No status stream found for bookingRequestId:", bookingRequestId);
              }

              // Clean up
              statusStreams.delete(bookingRequestId);
              statusQueues.delete(bookingRequestId);
            } catch (error) {
              // Handle booking errors gracefully
              console.error("[api/chat] Booking error:", error);
              console.error("[api/chat] Error stack:", error.stack);

              // Send error message via SSE and close stream
              const sendStatus = statusStreams.get(bookingRequestId);
              if (sendStatus) {
                try {
                  const errorMessage = error.message || "Failed to book appointment";
                  sendStatus(`Error: ${errorMessage}`);
                  // Small delay to ensure message is sent before closing
                  setTimeout(() => {
                    try {
                      sendStatus(null);
                    } catch (e) {
                      // Ignore errors if stream is already closed
                      console.warn("[api/chat] Stream already closed when trying to close:", e.message);
                    }
                  }, 100);
                } catch (e) {
                  // Ignore errors if stream is already closed
                  console.warn("[api/chat] Error sending status update:", e.message);
                }
              }
              statusStreams.delete(bookingRequestId);
              statusQueues.delete(bookingRequestId);
            }
          })();

          // Return immediately with placeholder message and statusRequestId
          // The actual result will come via SSE
          const updatedHistory = [
            ...priorMessages,
            { role: "user", content: message },
            { role: "assistant", content: "I'm processing your booking request..." },
          ];

          return res.json({
            reply: "I'm processing your booking request...",
            history: updatedHistory,
            statusRequestId: bookingRequestId,
          });
        } else {
          // Unknown tool - handle synchronously
          const toolMessages = [{
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: `Unknown tool: ${fn.name}`,
            }),
          }];

          const secondMessages = [
            ...messages,
            assistantMessage,
            ...toolMessages,
          ];

          const second = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: secondMessages,
          });

          finalAssistantMessage = second.choices[0]?.message || assistantMessage;
        }
      }
    }

    // Store only user + assistant messages on the client

    const updatedHistory = [
      ...priorMessages,
      { role: "user", content: message },
      { role: "assistant", content: finalAssistantMessage.content },
    ];

    res.json({
      reply: finalAssistantMessage.content,
      history: updatedHistory,
      ...(bookingRequestId && { statusRequestId: bookingRequestId }),
    });
  } catch (err) {
    console.error("[server] Error in /api/chat:", err);
    res.status(500).json({
      error: err.message || "Unknown server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Server listening on http://localhost:${PORT}`);
});

