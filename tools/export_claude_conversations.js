/**
 * Claude.ai Conversation Exporter
 * ================================
 *
 * Paste this into your browser's Developer Console (F12) while on claude.ai.
 * It uses Claude's internal API to fetch all your conversations.
 *
 * Usage:
 *   1. Go to https://claude.ai
 *   2. Open DevTools (F12) → Console tab
 *   3. Paste this entire script and press Enter
 *   4. Wait for it to finish (it'll show progress)
 *   5. A JSON file will download automatically
 *   6. Import into Shiba with: python3 tools/import_claude_to_shiba.py exported_conversations.json
 */

(async function exportClaudeConversations() {
  console.log("🐕 Shiba: Starting Claude conversation export...");

  // Get the organization ID from the page
  const orgId = document.cookie
    .split(";")
    .map(c => c.trim())
    .find(c => c.startsWith("lastActiveOrg="))
    ?.split("=")[1];

  if (!orgId) {
    // Try to get from the URL or page content
    const match = window.location.pathname.match(/\/([a-f0-9-]+)\//);
    if (!match) {
      console.error("Could not find organization ID. Make sure you're logged into claude.ai");
      return;
    }
  }

  // Fetch conversation list
  console.log("📋 Fetching conversation list...");
  let allConversations = [];
  let cursor = null;
  let page = 0;

  while (true) {
    const url = cursor
      ? `/api/organizations/${orgId}/chat_conversations?limit=50&after=${cursor}`
      : `/api/organizations/${orgId}/chat_conversations?limit=50`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`Failed to fetch conversations: ${resp.status}`);
        break;
      }
      const data = await resp.json();

      if (!data || data.length === 0) break;

      allConversations.push(...data);
      page++;
      console.log(`  Page ${page}: ${data.length} conversations (${allConversations.length} total)`);

      // Get cursor for next page
      if (data.length < 50) break;
      cursor = data[data.length - 1].uuid;
    } catch (e) {
      console.error("Error fetching conversations:", e);
      break;
    }
  }

  console.log(`\n📝 Found ${allConversations.length} conversations. Fetching messages...`);

  // Fetch full messages for each conversation
  const fullConversations = [];
  for (let i = 0; i < allConversations.length; i++) {
    const conv = allConversations[i];
    console.log(`  [${i + 1}/${allConversations.length}] ${conv.name || conv.uuid.slice(0, 8)}...`);

    try {
      const resp = await fetch(
        `/api/organizations/${orgId}/chat_conversations/${conv.uuid}`
      );
      if (resp.ok) {
        const full = await resp.json();
        fullConversations.push({
          id: conv.uuid,
          name: conv.name || "Untitled",
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          model: conv.model,
          messages: (full.chat_messages || []).map(m => ({
            role: m.sender === "human" ? "user" : "assistant",
            content: typeof m.text === "string" ? m.text : (m.content?.[0]?.text || ""),
            created_at: m.created_at,
          })),
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`  Skipped ${conv.uuid}: ${e.message}`);
    }
  }

  // Download as JSON
  const exportData = {
    exported_at: new Date().toISOString(),
    source: "claude.ai",
    conversation_count: fullConversations.length,
    total_messages: fullConversations.reduce((sum, c) => sum + c.messages.length, 0),
    conversations: fullConversations,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `claude_conversations_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(`\n✅ Exported ${fullConversations.length} conversations (${exportData.total_messages} messages)`);
  console.log("📁 File downloaded. Import into Shiba with:");
  console.log("   python3 tools/import_claude_to_shiba.py claude_conversations_*.json");
})();
