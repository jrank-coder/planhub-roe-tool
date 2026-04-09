const { onValueCreated } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const { getDatabase } = require("firebase-admin/database");
const { initializeApp } = require("firebase-admin/app");
const Anthropic = require("@anthropic-ai/sdk");
const { ROE_SYSTEM_PROMPT } = require("./roeSystemPrompt");

initializeApp();

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");
const hubspotKey = defineSecret("HUBSPOT_API_KEY");

exports.processROERequest = onValueCreated(
  {
    ref: "/roe-tool/requests/{requestId}",
    secrets: [anthropicKey, hubspotKey],
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (event) => {
    const requestId = event.params.requestId;
    const request = event.data.val();

    if (!request || request.status !== "pending") return;

    const db = getDatabase();
    const resultRef = db.ref(`/roe-tool/results/${requestId}`);

    try {
      // Fetch live HubSpot data for both deals if URLs provided
      let hubspotContext1 = "";
      let hubspotContext2 = "";

      if (request.hubspotUrl && hubspotKey.value()) {
        hubspotContext1 = await fetchHubSpotData(request.hubspotUrl, hubspotKey.value(), "Deal");
      }
      if (request.hubspotUrl2 && hubspotKey.value()) {
        hubspotContext2 = await fetchHubSpotData(request.hubspotUrl2, hubspotKey.value(), "Second Deal");
      }

      const userMessage = buildUserMessage(request, hubspotContext1, hubspotContext2);

      // Build message array (include conversation history for multi-turn)
      const messages = [];
      if (Array.isArray(request.conversationHistory)) {
        messages.push(...request.conversationHistory);
      }
      messages.push({ role: "user", content: userMessage });

      const client = new Anthropic({ apiKey: anthropicKey.value() });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: ROE_SYSTEM_PROMPT,
        messages,
      });

      const text = response.content.find((b) => b.type === "text")?.text || "";

      await resultRef.set({
        type: request.type,
        text,
        status: "complete",
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error("ROE processing error:", err);
      await resultRef.set({
        type: request.type,
        text: "Analysis failed. Please try again or contact RevOps directly.",
        status: "error",
        createdAt: Date.now(),
      });
    }
  }
);

// ─── Message builder ────────────────────────────────────────────────────────

function buildUserMessage(request, hubspotContext1, hubspotContext2) {
  if (request.type === "qa") {
    return request.question || "";
  }

  const lines = [
    "MODE: ELIGIBILITY_CHECK",
    `SITUATION: ${request.situationType || "Not specified"}`,
    "",
  ];

  if (hubspotContext1) {
    lines.push("DEAL DATA (from HubSpot):", hubspotContext1, "");
  } else if (request.hubspotUrl) {
    lines.push(`DEAL URL: ${request.hubspotUrl}`, "(HubSpot data unavailable)", "");
  }

  if (hubspotContext2) {
    lines.push("SECOND DEAL DATA (from HubSpot):", hubspotContext2, "");
  } else if (request.hubspotUrl2) {
    lines.push(`SECOND DEAL URL: ${request.hubspotUrl2}`, "(HubSpot data unavailable)", "");
  }

  if (request.additionalContext) {
    lines.push(`ADDITIONAL CONTEXT FROM AE: ${request.additionalContext}`, "");
  }

  return lines.join("\n");
}

// ─── HubSpot data fetcher ────────────────────────────────────────────────────

async function fetchHubSpotData(dealUrl, apiKey, label = "Deal") {
  try {
    const match = dealUrl.match(/\/deal\/(\d+)/);
    if (!match) return `(Could not parse deal ID from URL: ${dealUrl})`;
    const dealId = match[1];

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const dealProps = [
      "dealname", "pipeline", "dealstage", "closedate", "amount",
      "hubspot_owner_id", "opportunity_type", "deal_initiative",
      "last_ae_call_date", "last_connected_call_date",
      "50_split_ae", "partnership_association", "event_sourced",
      "sdr_qualification", "sdr_owner", "sdr_qualification_date",
      "hs_created_by_user_id",
    ].join(",");

    const dealRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=${dealProps}&associations=companies,contacts`,
      { headers }
    );

    if (!dealRes.ok) {
      return `(HubSpot ${label} lookup failed: HTTP ${dealRes.status})`;
    }

    const deal = await dealRes.json();
    const p = deal.properties || {};

    // ── Warm transfer / EverPro detection ──
    const isWarmTransfer = p.sdr_qualification === "Qualified: Warm Transfer";
    const isEverProMines = p.opportunity_type === "Outsourced";
    const isEverProNew = p.deal_initiative === "EverPro";
    const isEverPro = isEverProMines || isEverProNew;
    const warmTransferByDefinition = isWarmTransfer || isEverPro;

    // ── Deal creation method ──
    const createdByUserId = p.hs_created_by_user_id;
    let creationMethod;
    if (warmTransferByDefinition) {
      creationMethod = "Warm transfer / EverPro — duplicate check NOT required";
    } else if (!createdByUserId || createdByUserId === "0") {
      creationMethod = "System/automation-created — lower feasibility bar for duplicate check";
    } else {
      creationMethod = `Manually created by user ID ${createdByUserId} — full duplicate check required`;
    }

    const lines = [
      `Deal name: ${p.dealname || "Unknown"}`,
      `Owner ID: ${p.hubspot_owner_id || "Unknown"}`,
      `Pipeline: ${p.pipeline || "Unknown"}`,
      `Stage: ${p.dealstage || "Unknown"}`,
      `Opportunity type: ${p.opportunity_type || "Unknown"}`,
      `Deal initiative: ${p.deal_initiative || "None"}`,
      `Amount: ${p.amount ? "$" + Number(p.amount).toLocaleString() : "Unknown"}`,
      `Close date: ${p.closedate || "Unknown"}`,
      `SDR qualification: ${p.sdr_qualification || "None"}`,
      `SDR owner: ${p.sdr_owner || "None"}`,
      `50/50 split AE: ${p["50_split_ae"] || "None"}`,
      `Partnership association: ${p.partnership_association || "None"}`,
      `Event sourced: ${p.event_sourced || "No"}`,
      `Deal creation method: ${creationMethod}`,
    ];

    if (isWarmTransfer) lines.push("⚠ WARM TRANSFER — duplicate check not required per ROE");
    if (isEverPro) lines.push(`⚠ EVERPRO DEAL (${isEverProMines ? "Mines/Outsourced" : "New"}) — warm transfer by definition, duplicate check not required per ROE`);

    // ── Associated company ──
    const companyId = deal.associations?.companies?.results?.[0]?.id;
    if (companyId) {
      const companyProps = [
        "name", "subscription", "chargebee_status",
        "chargebee_cancellation_date", "planhub_company_create_date",
        "domain", "phone",
      ].join(",");

      const companyRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=${companyProps}`,
        { headers }
      );

      if (companyRes.ok) {
        const company = await companyRes.json();
        const cp = company.properties || {};
        lines.push(
          "",
          `Company: ${cp.name || "Unknown"}`,
          `Domain: ${cp.domain || "Unknown"}`,
          `Phone: ${cp.phone || "Unknown"}`,
          `Subscription (company-level): ${cp.subscription || "Unknown"}`,
          `Chargebee status: ${cp.chargebee_status || "Unknown"}`,
          `Chargebee cancellation date: ${cp.chargebee_cancellation_date || "None"}`,
          `PlanHub registration date: ${cp.planhub_company_create_date || "Unknown"}`
        );
      }
    }

    // ── Associated contacts (for duplicate company matching) ──
    const contactId = deal.associations?.contacts?.results?.[0]?.id;
    if (contactId) {
      const contactRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone`,
        { headers }
      );
      if (contactRes.ok) {
        const contact = await contactRes.json();
        const ct = contact.properties || {};
        lines.push(
          "",
          `Primary contact: ${ct.firstname || ""} ${ct.lastname || ""}`.trim() || "Unknown",
          `Contact email: ${ct.email || "Unknown"}`,
          `Contact phone: ${ct.phone || "Unknown"}`
        );
      }
    }

    // ── Calls in last 30 days ──
    const callAssocRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/calls`,
      { headers }
    );

    if (callAssocRes.ok) {
      const callAssoc = await callAssocRes.json();
      const callIds = (callAssoc.results || []).slice(0, 20).map((c) => c.id);

      if (callIds.length > 0) {
        const batchRes = await fetch(
          "https://api.hubapi.com/crm/v3/objects/calls/batch/read",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              inputs: callIds.map((id) => ({ id })),
              properties: [
                "hs_call_duration", "hs_call_direction", "hs_call_status",
                "hs_timestamp", "hs_call_body", "hs_call_source",
              ],
            }),
          }
        );

        if (batchRes.ok) {
          const batchData = await batchRes.json();
          const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

          const recentCalls = (batchData.results || []).filter((call) => {
            const ts = call.properties.hs_timestamp
              ? new Date(call.properties.hs_timestamp).getTime()
              : 0;
            const notes = (call.properties.hs_call_body || "").toLowerCase();
            const source = (call.properties.hs_call_source || "").toLowerCase();
            return ts >= thirtyDaysAgo && !notes.includes("gong") && source !== "playbook";
          });

          const meaningfulCalls = recentCalls.filter((c) => {
            const dur = c.properties.hs_call_duration
              ? Math.round(Number(c.properties.hs_call_duration) / 1000)
              : 0;
            return dur >= 25;
          });

          // Get unique call days
          const callDays = new Set(
            meaningfulCalls.map((c) =>
              c.properties.hs_timestamp
                ? new Date(c.properties.hs_timestamp).toLocaleDateString()
                : null
            ).filter(Boolean)
          );

          lines.push(
            "",
            `Calls in last 30 days (gong/playbook excluded): ${recentCalls.length}`,
            `Meaningful calls (≥25s): ${meaningfulCalls.length}`,
            `Unique call days: ${callDays.size}`
          );

          recentCalls.forEach((call) => {
            const cp = call.properties;
            const durationSec = cp.hs_call_duration
              ? Math.round(Number(cp.hs_call_duration) / 1000)
              : 0;
            const date = cp.hs_timestamp
              ? new Date(cp.hs_timestamp).toLocaleDateString()
              : "Unknown date";
            const meaningful = durationSec >= 25 ? "✓ meaningful" : "✗ too short (<25s)";
            lines.push(`  - ${date}: ${durationSec}s — ${meaningful}`);
          });
        }
      } else {
        lines.push("", "Calls in last 30 days: none found");
      }
    }

    return lines.join("\n");
  } catch (err) {
    console.error(`HubSpot fetch error (${label}):`, err);
    return `(HubSpot data unavailable: ${err.message})`;
  }
}
