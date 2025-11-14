// public/app.js

const chatEl = document.getElementById("chat");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");

// We'll keep just { role, content } for user/assistant messages.
let history = [];
let statusIndicator = null;

function appendMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function showStatus(text) {
  hideStatus();
  statusIndicator = document.createElement("div");
  statusIndicator.className = "status-indicator";
  statusIndicator.innerHTML = `<span class="status-spinner"></span>${text}`;
  chatEl.appendChild(statusIndicator);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function hideStatus() {
  if (statusIndicator) {
    statusIndicator.remove();
    statusIndicator = null;
  }
}

function connectToStatusStream(requestId) {
  // Show initial status when booking starts
  showStatus("Booking your appointment...");

  const eventSource = new EventSource(`/api/status/${requestId}`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("[status] Received status update:", data);
      if (data.done) {
        // Stream is complete, close connection and hide status
        console.log("[status] Stream completed, closing connection");
        eventSource.close();
        hideStatus();
      } else if (data.message && data.message !== "Connected") {
        // Check if this is a final message (starts with "final:")
        if (data.message.startsWith("final:")) {
          const finalMessage = data.message.substring(6); // Remove "final:" prefix
          console.log("[status] Final message received, updating chat:", finalMessage);

          // Update the last assistant message in the chat
          const messages = chatEl.querySelectorAll(".message.assistant");
          if (messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            lastMessage.textContent = finalMessage;
          }

          // Update history
          if (history.length > 0 && history[history.length - 1].role === "assistant") {
            history[history.length - 1].content = finalMessage;
          }

          // Hide status indicator
          hideStatus();
        } else if (data.message.startsWith("Error:")) {
          // Error message - update chat with error
          const errorMessage = data.message;
          console.log("[status] Error message:", errorMessage);

          // Update the last assistant message in the chat
          const messages = chatEl.querySelectorAll(".message.assistant");
          if (messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            lastMessage.textContent = errorMessage;
          }

          // Update history
          if (history.length > 0 && history[history.length - 1].role === "assistant") {
            history[history.length - 1].content = errorMessage;
          }

          // Show in status indicator briefly, then hide
          showStatus(errorMessage);
          setTimeout(() => {
            hideStatus();
          }, 3000);
        } else {
          // Regular status update
          console.log("[status] Updating status UI:", data.message);
          showStatus(data.message);
        }
      }
    } catch (e) {
      console.error("[status] Failed to parse status message:", e);
    }
  };

  eventSource.onopen = () => {
    console.log("[status] SSE connection opened");
  };

  eventSource.onerror = (error) => {
    console.error("[status] SSE error:", error);
    eventSource.close();
    // Hide status after a delay if connection fails
    setTimeout(() => {
      if (statusIndicator) {
        hideStatus();
      }
    }, 1000);
  };
}

async function sendMessage(text) {
  appendMessage("user", text);

  // Disable UI while request is in flight
  inputEl.value = "";
  inputEl.disabled = true;
  formEl.querySelector("button").disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: text,
        history,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Chat error:", errText);
      appendMessage(
        "assistant",
        "Sorry, something went wrong talking to the server."
      );
      return;
    }

    const data = await res.json();

    // Only show status UI when a tool call was submitted (booking initiated)
    if (data.statusRequestId) {
      connectToStatusStream(data.statusRequestId);
    }

    history = data.history || history;
    appendMessage("assistant", data.reply || "[No reply]");
  } catch (e) {
    console.error(e);
    appendMessage(
      "assistant",
      "Network error – please try again in a moment."
    );
  } finally {
    inputEl.disabled = false;
    formEl.querySelector("button").disabled = false;
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  sendMessage(text);
});

// Optional: greet user
appendMessage(
  "assistant",
  "Hi! 👋 I can help you book an appointment. What can I do for you today?"
);

