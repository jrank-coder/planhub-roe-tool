const { onValueCreated } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const { getDatabase } = require("firebase-admin/database");
const { initializeApp } = require("firebase-admin/app");
const Anthropic = require("@anthropic-ai/sdk");
const { ROE_SYSTEM_PROMPT } = require("./roeSystemPrompt");

initializeApp();

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");
const hubspotKey = defineSecret("HUBSPOT_API_KEY");

// HubSpot fetch with 10-second timeout per call to prevent function-level hangs
function hsFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
}

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
      const fetchPromises = [];
      if (request.hubspotUrl && hubspotKey.value()) {
        fetchPromises.push(fetchHubSpotData(request.hubspotUrl, hubspotKey.value(), "Record 1"));
      } else {
        fetchPromises.push(Promise.resolve(""));
      }
      if (request.hubspotUrl2 && hubspotKey.value()) {
        fetchPromises.push(fetchHubSpotData(request.hubspotUrl2, hubspotKey.value(), "Record 2"));
      } else {
        fetchPromises.push(Promise.resolve(""));
      }
      if (request.userEmail && hubspotKey.value()) {
        fetchPromises.push(lookupHubSpotOwner(request.userEmail, hubspotKey.value()));
      } else {
        fetchPromises.push(Promise.resolve(null));
      }

      const [hubspotContext1, hubspotContext2, aeIdentity] = await Promise.all(fetchPromises);

      const userMessage = buildUserMessage(request, hubspotContext1, hubspotContext2, aeIdentity);

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

function buildUserMessage(request, hubspotContext1, hubspotContext2, aeIdentity) {
  if (request.type === "qa") {
    const lines = [];
    if (aeIdentity) {
      lines.push(
        "AE IDENTITY (logged-in user):",
        `Name: ${aeIdentity.name}`,
        `Email: ${aeIdentity.email}`,
        `HubSpot Owner ID: ${aeIdentity.id}`,
        ""
      );
    }
    lines.push(request.question || "");
    return lines.join("\n");
  }

  const lines = [
    "MODE: ELIGIBILITY_CHECK",
    `SITUATION: ${request.situationType || "Not specified"}`,
    "",
  ];

  if (aeIdentity) {
    lines.push(
      "AE IDENTITY (logged-in user):",
      `Name: ${aeIdentity.name}`,
      `Email: ${aeIdentity.email}`,
      `HubSpot Owner ID: ${aeIdentity.id}`,
      ""
    );
  }

  if (hubspotContext1) {
    lines.push("HUBSPOT DATA (Record 1):", hubspotContext1, "");
  } else if (request.hubspotUrl) {
    lines.push(`HUBSPOT URL (Record 1): ${request.hubspotUrl}`, "(HubSpot data unavailable)", "");
  }

  if (hubspotContext2) {
    lines.push("HUBSPOT DATA (Record 2):", hubspotContext2, "");
  } else if (request.hubspotUrl2) {
    lines.push(`HUBSPOT URL (Record 2): ${request.hubspotUrl2}`, "(HubSpot data unavailable)", "");
  }

  if (request.additionalContext) {
    lines.push(`ADDITIONAL CONTEXT FROM AE: ${request.additionalContext}`, "");
  }

  return lines.join("\n");
}

// ─── HubSpot owner lookup ────────────────────────────────────────────────────

async function lookupHubSpotOwner(email, apiKey) {
  try {
    const res = await hsFetch(
      `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const owner = data.results?.[0];
    if (!owner) return null;
    return {
      id: owner.id,
      name: `${owner.firstName} ${owner.lastName}`.trim(),
      email: owner.email,
    };
  } catch {
    return null;
  }
}

// ─── URL type detection ──────────────────────────────────────────────────────

function parseHubSpotUrl(url) {
  const dealMatch = url.match(/\/deal\/(\d+)/);
  if (dealMatch) return { type: "deal", id: dealMatch[1] };

  const companyMatch = url.match(/\/company\/(\d+)/);
  if (companyMatch) return { type: "company", id: companyMatch[1] };

  const contactMatch = url.match(/\/contact\/(\d+)/);
  if (contactMatch) return { type: "contact", id: contactMatch[1] };

  return null;
}

// ─── Main HubSpot dispatcher ─────────────────────────────────────────────────

async function fetchHubSpotData(url, apiKey, label = "Record") {
  try {
    const parsed = parseHubSpotUrl(url);
    if (!parsed) {
      return `(Could not parse HubSpot URL — expected a /deal/, /company/, or /contact/ path: ${url})`;
    }

    if (parsed.type === "deal") return await fetchDealData(parsed.id, apiKey, label);
    if (parsed.type === "company") return await fetchCompanyData(parsed.id, apiKey, label);
    if (parsed.type === "contact") return await fetchContactData(parsed.id, apiKey, label);

    return `(Unrecognized HubSpot URL type: ${url})`;
  } catch (err) {
    console.error(`HubSpot fetch error (${label}):`, err);
    return `(HubSpot data unavailable: ${err.message})`;
  }
}

// ─── Deal fetcher ────────────────────────────────────────────────────────────

async function fetchDealData(dealId, apiKey, label = "Deal") {
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

  const dealRes = await hsFetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=${dealProps}&associations=companies,contacts`,
    { headers }
  );

  if (!dealRes.ok) {
    return `(HubSpot ${label} lookup failed: HTTP ${dealRes.status})`;
  }

  const deal = await dealRes.json();
  const p = deal.properties || {};

  const isWarmTransfer = p.sdr_qualification === "Qualified: Warm Transfer";
  const isEverProMines = p.opportunity_type === "Outsourced";
  const isEverProNew = p.deal_initiative === "EverPro";
  const isEverPro = isEverProMines || isEverProNew;
  const warmTransferByDefinition = isWarmTransfer || isEverPro;

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
    `[${label.toUpperCase()} — DEAL RECORD]`,
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

  // Fetch company, contact, and calls in parallel
  const companyId = deal.associations?.companies?.results?.[0]?.id;
  const contactId = deal.associations?.contacts?.results?.[0]?.id;

  const [companyLines, contactRes, callLines] = await Promise.all([
    companyId ? fetchCompanyProperties(companyId, headers) : Promise.resolve([]),
    contactId ? hsFetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone`, { headers }) : Promise.resolve(null),
    fetchCallsForDeal(dealId, headers),
  ]);

  if (companyLines.length) lines.push("", ...companyLines);

  if (contactRes?.ok) {
    const contact = await contactRes.json();
    const ct = contact.properties || {};
    lines.push(
      "",
      `Primary contact: ${`${ct.firstname || ""} ${ct.lastname || ""}`.trim() || "Unknown"}`,
      `Contact email: ${ct.email || "Unknown"}`,
      `Contact phone: ${ct.phone || "Unknown"}`
    );
  }

  lines.push("", ...callLines);

  return lines.join("\n");
}

// ─── Company fetcher ─────────────────────────────────────────────────────────

async function fetchCompanyData(companyId, apiKey, label = "Company") {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const lines = [`[${label.toUpperCase()} — COMPANY RECORD]`];

  const companyLines = await fetchCompanyProperties(companyId, headers);
  lines.push(...companyLines);

  // Associated deals
  const dealAssocRes = await hsFetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/deals`,
    { headers }
  );

  if (!dealAssocRes.ok) {
    lines.push("", "(Could not retrieve associated deals)");
    return lines.join("\n");
  }

  const dealAssoc = await dealAssocRes.json();
  const allDealIds = (dealAssoc.results || []).map((d) => d.id);
  const dealIds = allDealIds.slice(0, 5);

  if (dealIds.length === 0) {
    lines.push("", "Associated deals: none found");
    return lines.join("\n");
  }

  lines.push(
    "",
    `Associated deals (${allDealIds.length} total${allDealIds.length > 5 ? ", showing 5 most recent" : ""}):`
  );

  const batchRes = await hsFetch(
    "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: dealIds.map((id) => ({ id })),
        properties: [
          "dealname", "pipeline", "dealstage", "closedate", "amount",
          "hubspot_owner_id", "opportunity_type", "deal_initiative",
          "sdr_qualification", "sdr_owner", "50_split_ae",
        ],
      }),
    }
  );

  if (batchRes.ok) {
    const batchData = await batchRes.json();
    for (const d of (batchData.results || [])) {
      const dp = d.properties || {};
      lines.push(
        "",
        `  Deal: ${dp.dealname || "Unknown"}`,
        `  Deal ID: ${d.id}`,
        `  Owner ID: ${dp.hubspot_owner_id || "Unknown"}`,
        `  Pipeline: ${dp.pipeline || "Unknown"}`,
        `  Stage: ${dp.dealstage || "Unknown"}`,
        `  Amount: ${dp.amount ? "$" + Number(dp.amount).toLocaleString() : "Unknown"}`,
        `  Close date: ${dp.closedate || "Unknown"}`
      );
      const callLines = await fetchCallsForDeal(d.id, headers);
      lines.push(...callLines.map((l) => `  ${l}`));
    }
  }

  return lines.join("\n");
}

// ─── Contact fetcher ─────────────────────────────────────────────────────────

async function fetchContactData(contactId, apiKey, label = "Contact") {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const contactRes = await hsFetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone&associations=companies,deals`,
    { headers }
  );

  if (!contactRes.ok) {
    return `(HubSpot ${label} lookup failed: HTTP ${contactRes.status})`;
  }

  const contact = await contactRes.json();
  const ct = contact.properties || {};

  const lines = [
    `[${label.toUpperCase()} — CONTACT RECORD]`,
    `Name: ${`${ct.firstname || ""} ${ct.lastname || ""}`.trim() || "Unknown"}`,
    `Email: ${ct.email || "Unknown"}`,
    `Phone: ${ct.phone || "Unknown"}`,
  ];

  const companyId = contact.associations?.companies?.results?.[0]?.id;

  if (companyId) {
    lines.push("", "→ Associated company found:");
    const companyData = await fetchCompanyData(companyId, apiKey, "Associated Company");
    lines.push(companyData);
    return lines.join("\n");
  }

  // No associated company — fall back to contact's associated deals
  lines.push("", "(No associated company found)");

  const allDealIds = (contact.associations?.deals?.results || []).map((d) => d.id);
  const dealIds = allDealIds.slice(0, 5);

  if (dealIds.length === 0) {
    lines.push("Associated deals: none found");
    return lines.join("\n");
  }

  lines.push(
    "",
    `Associated deals (${allDealIds.length} total${allDealIds.length > 5 ? ", showing 5 most recent" : ""}):`
  );

  const batchRes = await hsFetch(
    "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: dealIds.map((id) => ({ id })),
        properties: [
          "dealname", "pipeline", "dealstage", "closedate", "amount",
          "hubspot_owner_id", "opportunity_type", "deal_initiative",
          "sdr_qualification", "sdr_owner", "50_split_ae",
        ],
      }),
    }
  );

  if (batchRes.ok) {
    const batchData = await batchRes.json();
    for (const d of (batchData.results || [])) {
      const dp = d.properties || {};
      lines.push(
        "",
        `  Deal: ${dp.dealname || "Unknown"}`,
        `  Deal ID: ${d.id}`,
        `  Owner ID: ${dp.hubspot_owner_id || "Unknown"}`,
        `  Pipeline: ${dp.pipeline || "Unknown"}`,
        `  Stage: ${dp.dealstage || "Unknown"}`,
        `  Amount: ${dp.amount ? "$" + Number(dp.amount).toLocaleString() : "Unknown"}`,
        `  Close date: ${dp.closedate || "Unknown"}`
      );
      const callLines = await fetchCallsForDeal(d.id, headers);
      lines.push(...callLines.map((l) => `  ${l}`));
    }
  }

  return lines.join("\n");
}

// ─── Company properties helper ───────────────────────────────────────────────

async function fetchCompanyProperties(companyId, headers) {
  const companyProps = [
    "name", "subscription", "chargebee_status",
    "chargebee_cancellation_date", "chargebee_activation_date",
    "planhub_company_create_date", "domain", "phone",
    "key_account", "account_manager", "n90_day_success_manager",
    "company_specialty", "company_partnership_association",
  ].join(",");

  const companyRes = await hsFetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=${companyProps}`,
    { headers }
  );

  if (!companyRes.ok) return [`(Company lookup failed: HTTP ${companyRes.status})`];

  const company = await companyRes.json();
  const cp = company.properties || {};

  return [
    `Company: ${cp.name || "Unknown"}`,
    `Domain: ${cp.domain || "Unknown"}`,
    `Phone: ${cp.phone || "Unknown"}`,
    `Subscription (company-level): ${cp.subscription || "Unknown"}`,
    `Chargebee status: ${cp.chargebee_status || "Unknown"}`,
    `Chargebee activation date: ${cp.chargebee_activation_date || "None"}`,
    `Chargebee cancellation date: ${cp.chargebee_cancellation_date || "None"}`,
    `PlanHub registration date: ${cp.planhub_company_create_date || "Unknown"}`,
    `Key account: ${cp.key_account || "No"}`,
    `Account manager: ${cp.account_manager || "Unknown"}`,
    `n90 day success manager: ${cp.n90_day_success_manager || "None"}`,
    `Company specialty: ${cp.company_specialty || "Unknown"}`,
    `Partnership association (company): ${cp.company_partnership_association || "None"}`,
  ];
}

// ─── Calls helper ────────────────────────────────────────────────────────────

async function fetchCallsForDeal(dealId, headers) {
  const lines = [];

  const callAssocRes = await hsFetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/calls`,
    { headers }
  );

  if (!callAssocRes.ok) return lines;

  const callAssoc = await callAssocRes.json();
  const callIds = (callAssoc.results || []).slice(0, 20).map((c) => c.id);

  if (callIds.length === 0) {
    lines.push("Calls in last 30 days: none found");
    return lines;
  }

  const batchRes = await hsFetch(
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

  if (!batchRes.ok) return lines;

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

  const callDays = new Set(
    meaningfulCalls
      .map((c) =>
        c.properties.hs_timestamp
          ? new Date(c.properties.hs_timestamp).toLocaleDateString()
          : null
      )
      .filter(Boolean)
  );

  lines.push(
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

  return lines;
}
