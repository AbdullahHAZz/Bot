require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require("discord.js");

// ================== CONFIG ==================
const timeZone = "UTC"; // UTC فقط
const HOLD_MINUTES_AFTER_START = 10; // لازم يظل بالفويس بعد البداية
const TOKEN = process.env.TOKEN;

const OWNER_USER_ID = process.env.OWNER_USER_ID || "";
const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ROSTER_CREATOR_ROLE_IDS = (process.env.ROSTER_CREATOR_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ================== FILES ==================
const TYPES_FILE = path.join(__dirname, "roster_types.json");
const EVENTS_FILE = path.join(__dirname, "rosters.json");

// ================== JSON HELPERS ==================
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const txt = fs.readFileSync(filePath, "utf8");
    return JSON.parse(txt || "null") ?? fallback;
  } catch (e) {
    console.error("readJsonSafe error:", filePath, e);
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeTypeCfg(raw, fallbackTypeId = "") {
  const typeId = normalizeTypeId(raw?.typeId || fallbackTypeId);
  const displayName = sanitizeTypeName(raw?.displayName || raw?.name || typeId || "Type");
  const mainRoleIds = Array.from(new Set((raw?.mainRoleIds || []).map((x) => String(x || "").trim()).filter(Boolean)));
  const subRoleIds = Array.from(new Set((raw?.subRoleIds || []).map((x) => String(x || "").trim()).filter(Boolean)));
  const hasAnyRolePool = mainRoleIds.length > 0 || subRoleIds.length > 0;

  return {
    ...(raw || {}),
    typeId,
    displayName,
    rosterChannelId: raw?.rosterChannelId ? String(raw.rosterChannelId).trim() : "",
    announceChannelId: raw?.announceChannelId ? String(raw.announceChannelId).trim() : "",
    voiceChannelId: raw?.voiceChannelId ? String(raw.voiceChannelId).trim() : "",
    mentionRoleId: raw?.mentionRoleId ? String(raw.mentionRoleId).trim() : null,
    closeBeforeMin: clampInt(raw?.closeBeforeMin, 5, 0, 180),
    requireRole: hasAnyRolePool ? !!raw?.requireRole : false,
    mainRoleIds,
    subRoleIds,
    defaultMainLimit: clampInt(raw?.defaultMainLimit, 10, 0, 200),
    defaultSubLimit: clampInt(raw?.defaultSubLimit, 10, 0, 200),
    defaultDurationMin: clampInt(raw?.defaultDurationMin, 60, 15, 600),
  };
}

function loadTypesDB() {
  const db = readJsonSafe(TYPES_FILE, { types: {} });
  const types = db?.types && typeof db.types === "object" ? db.types : {};
  const out = {};
  let changed = false;

  for (const [k, v] of Object.entries(types)) {
    const nk = normalizeTypeId(k || v?.typeId);
    if (!nk) continue;
    const nextCfg = normalizeTypeCfg(v, nk);
    const prev = out[nk];
    if (!prev) {
      out[nk] = nextCfg;
    } else {
      out[nk] = normalizeTypeCfg({
        ...prev,
        ...nextCfg,
        typeId: nk,
        mainRoleIds: Array.from(new Set([...(prev.mainRoleIds || []), ...(nextCfg.mainRoleIds || [])])),
        subRoleIds: Array.from(new Set([...(prev.subRoleIds || []), ...(nextCfg.subRoleIds || [])])),
      }, nk);
    }

    if (nk !== k || JSON.stringify(v || {}) != JSON.stringify(out[nk] || {})) changed = true;
  }

  const cleaned = { types: out };
  if (changed) {
    try { writeJsonSafe(TYPES_FILE, cleaned); } catch {}
  }
  return cleaned;
}
const saveTypesDB = (db) => writeJsonSafe(TYPES_FILE, db);

function normalizeRosterRecord(raw, fallbackRosterId = "") {
  const rosterId = String(raw?.rosterId || fallbackRosterId || "").trim();
  const event = raw?.event && typeof raw.event === "object" ? raw.event : {};
  const startIso = event?.startIso ? String(event.startIso).trim() : "";
  const parsedStart = DateTime.fromISO(startIso).setZone(timeZone);

  let endIso = event?.endIso ? String(event.endIso).trim() : "";
  let durationMin = clampInt(event?.durationMin, 60, 1, 600);

  if (startIso && endIso) {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      durationMin = clampInt(Math.round((endMs - startMs) / 60000), durationMin, 1, 600);
    }
  }

  if ((!endIso || !DateTime.fromISO(endIso).setZone(timeZone).isValid) && parsedStart.isValid) {
    endIso = parsedStart.plus({ minutes: durationMin }).toISO();
  }

  const announceMessageIds = Array.from(new Set((raw?.announceMessageIds || []).map((x) => String(x || "").trim()).filter(Boolean)));
  const remindersMinutes = parseRemindersList(raw?.remindersMinutes, [20, 10, 0]);
  const normalizedRsvp = {};
  for (const [uid, v] of Object.entries(raw?.rsvp || {})) {
    const userId = String(uid || "").trim();
    if (!userId) continue;
    const status = ["JOINED", "DECLINED", "REJECTED"].includes(v?.status) ? v.status : "DECLINED";
    const tier = status === "JOINED" && ["MAIN", "SUB"].includes(v?.tier) ? v.tier : null;
    normalizedRsvp[userId] = {
      status,
      tier,
      name: String(v?.name || "Unknown").trim() || "Unknown",
      at: Number.isFinite(Number(v?.at)) ? Number(v.at) : Date.now(),
      present: v?.present === true ? true : v?.present === false ? false : null,
      eligibleAtMinus5: !!v?.eligibleAtMinus5,
      rejectedReason: v?.rejectedReason ? String(v.rejectedReason) : null,
    };
  }

  return {
    ...(raw || {}),
    rosterId,
    guildId: raw?.guildId ? String(raw.guildId).trim() : "",
    typeId: normalizeTypeId(raw?.typeId),
    status: ["SCHEDULED", "OPEN", "CLOSED", "DONE"].includes(raw?.status) ? raw.status : "SCHEDULED",
    creatorId: raw?.creatorId ? String(raw.creatorId).trim() : "",
    remindersMinutes,
    event: {
      title: String(event?.title || raw?.typeId || "Roster").trim() || "Roster",
      description: String(event?.description || "").trim(),
      startIso,
      endIso,
      durationMin,
      mainLimit: clampInt(event?.mainLimit, 10, 0, 200),
      subLimit: clampInt(event?.subLimit, 10, 0, 200),
      closeBeforeMin: clampInt(event?.closeBeforeMin, 5, 0, 180),
      repeats: String(event?.repeats || "None"),
      attendeeRoleId: event?.attendeeRoleId ? String(event.attendeeRoleId).trim() : null,
    },
    rosterMessageId: raw?.rosterMessageId ? String(raw.rosterMessageId).trim() : null,
    rosterMessageUrl: raw?.rosterMessageUrl ? String(raw.rosterMessageUrl).trim() : null,
    announceMessageIds,
    rsvp: normalizedRsvp,
  };
}

function loadEventsDB() {
  const db = readJsonSafe(EVENTS_FILE, { events: {} });
  const events = db?.events && typeof db.events === "object" ? db.events : {};
  const out = {};
  let changed = false;

  for (const [k, v] of Object.entries(events)) {
    const nk = String(k || v?.rosterId || "").trim();
    if (!nk) continue;
    out[nk] = normalizeRosterRecord(v, nk);
    if (nk !== k || JSON.stringify(v || {}) != JSON.stringify(out[nk] || {})) changed = true;
  }

  const cleaned = { events: out };
  if (changed) {
    try { writeJsonSafe(EVENTS_FILE, cleaned); } catch {}
  }
  return cleaned;
}

function saveEventsDB(db) {
  const events = db?.events && typeof db.events === "object" ? db.events : {};
  const cleaned = { events: {} };
  for (const [k, v] of Object.entries(events)) {
    const nk = String(k || v?.rosterId || "").trim();
    if (!nk) continue;
    cleaned.events[nk] = normalizeRosterRecord(v, nk);
  }
  writeJsonSafe(EVENTS_FILE, cleaned);
}

// ================== TIME HELPERS ==================
function toUnix(iso) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function nowMs() {
  return Date.now();
}

function getEventTime(dayOfWeek, hour, minute) {
  // dayOfWeek: 1..7 (Luxon weekday)
  const today = DateTime.now().setZone(timeZone);
  const dayDiff = (dayOfWeek - today.weekday + 7) % 7;

  const eventTime = today
    .plus({ days: dayDiff })
    .set({ hour, minute, second: 0, millisecond: 0 });

  return eventTime.toISO();
}

function computeReminderTimesMs(startIso, remindersMinutes) {
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return [];

  const uniq = Array.from(
    new Set(
      (remindersMinutes || [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0)
    )
  );

  // الأكبر = أبكر (20 قبل 10)
  uniq.sort((a, b) => b - a);

  return uniq.map((m) => ({
    minutes: m,
    atMs: startMs - m * 60 * 1000,
  }));
}

// ================== ID ==================
function genRosterId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    "R_" +
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    "_" +
    Math.random().toString(36).slice(2, 7).toUpperCase()
  );
}

// ================== PERMISSIONS ==================
function isController(member) {
  if (!member) return false;
  if (OWNER_USER_ID && member.id === OWNER_USER_ID) return true;

  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  if (ADMIN_ROLE_IDS.length) {
    return ADMIN_ROLE_IDS.some((rid) => member.roles?.cache?.has?.(rid));
  }
  return false;
}

function canEditType(member) {
  return isController(member);
}

function canCreateRoster(member) {
  if (!member) return false;
  if (canEditType(member)) return true;
  const ids = ROSTER_CREATOR_ROLE_IDS.length ? ROSTER_CREATOR_ROLE_IDS : ADMIN_ROLE_IDS;
  if (ids.length) return ids.some((rid) => member.roles?.cache?.has?.(rid));
  return false;
}

function normalizeTypeId(raw) {
  return String(raw || "").trim().toLowerCase();
}

function sanitizeTypeName(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim();
}

function buildTypeKeyFromName(raw) {
  return sanitizeTypeName(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function makeUniqueTypeIdFromName(rawName, existingTypes = {}) {
  const base = buildTypeKeyFromName(rawName) || "type";
  let key = base;
  let i = 2;
  while (existingTypes?.[key]) {
    key = `${base}_${i}`;
    i += 1;
  }
  return key;
}

function typeDisplayLabel(typeId, cfg = null) {
  const key = normalizeTypeId(typeId);
  const name = sanitizeTypeName(cfg?.displayName || cfg?.name || key || "Type");
  return name === key || !key ? name : `${name} (${key})`;
}

function parseIdFromMentionOrId(s) {
  const str = String(s || "").trim();
  const mm = str.match(/^(?:<[@#&]!?)?(\d{15,25})>?$/);
  return mm ? mm[1] : "";
}

function parseIdsCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => parseIdFromMentionOrId(x))
    .filter(Boolean);
}

function normalizeName(member, user) {
  return member?.displayName || user?.globalName || user?.username || "Unknown";
}

// ================== TYPE CFG ==================
function getTypeCfg(typeId) {
  const db = loadTypesDB();
  const key = normalizeTypeId(typeId);
  return db.types?.[key] || null;
}


function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseRemindersList(raw, fallback = [20, 10, 0]) {
  const list = Array.from(new Set(String(raw || "")
    .split(",")
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)))
    .sort((a, b) => b - a);
  return list.length ? list : [...fallback];
}

function buildRosterRecord({ rosterId, guildId, creatorId, typeId, typeCfg, title, description, startIso, endIso, mainLimit, subLimit, remindersMinutes, repeats, attendeeRoleId, closeBeforeMin }) {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const durationMin = Math.max(1, Math.round((endMs - startMs) / 60000));

  const cfgClose = Number(typeCfg?.closeBeforeMin);
  const resolvedCloseBeforeMin = Number.isFinite(Number(closeBeforeMin))
    ? clampInt(closeBeforeMin, 5, 0, 180)
    : (Number.isFinite(cfgClose) ? clampInt(cfgClose, 5, 0, 180) : 5);

  return {
    rosterId,
    guildId,
    typeId: normalizeTypeId(typeId),
    status: "SCHEDULED",
    creatorId,
    remindersMinutes: parseRemindersList(remindersMinutes),
    event: {
      title: String(title || typeCfg?.typeId || "Roster").trim() || "Roster",
      description: String(description || "").trim(),
      startIso,
      endIso,
      durationMin,
      mainLimit: clampInt(mainLimit, 10, 0, 200),
      subLimit: clampInt(subLimit, 10, 0, 200),
      closeBeforeMin: resolvedCloseBeforeMin,
      repeats: String(repeats || "None"),
      attendeeRoleId: attendeeRoleId || null,
    },
    rosterMessageId: null,
    rosterMessageUrl: null,
    announceMessageIds: [],
    rsvp: {},
  };
}

// ================== EVENT STATE ==================
function isClosed(eventObj) {
  const startMs = new Date(eventObj?.event?.startIso).getTime();
  if (!Number.isFinite(startMs)) return false;
    const closeMin = Number(eventObj?.event?.closeBeforeMin);
  const closeMs = startMs - (Number.isFinite(closeMin) ? closeMin : 0) * 60 * 1000;
  return nowMs() >= closeMs;
}

// ================== RSVP LOGIC (MAIN/SUB/WAITLIST) ==================
function countTier(eventObj, tier) {
  let c = 0;
  for (const v of Object.values(eventObj.rsvp || {})) {
    if (v.status === "JOINED" && v.tier === tier) c++;
  }
  return c;
}

function applyJoin(eventObj, userId, name, opts) {
  const mainLimit = Number(eventObj.event.mainLimit) || 0;
  const subLimit = Number(eventObj.event.subLimit) || 0;

  const hasMainRole = !!opts?.hasMainRole;
  const hasSubRole = !!opts?.hasSubRole;
  const requireRole = !!opts?.requireRole;

  // Role required على أي تسجيل
  if (requireRole && !hasMainRole && !hasSubRole) {
    return { ok: false, reason: "MISSING_ROLE" };
  }

  const mainCount = countTier(eventObj, "MAIN");
  const subCount = countTier(eventObj, "SUB");

  // No WAITLIST: إذا ما فيه مكان = Reject
  let tier = null;

  if (mainCount < mainLimit) tier = "MAIN";
  else if (subCount < subLimit) tier = "SUB";
  else return { ok: false, reason: "FULL" };

  // لو كان مسجل قبل، لا تغيّر at (أولوية A)
  const prev = eventObj.rsvp?.[userId];
  const at = prev?.at || Date.now();

  eventObj.rsvp[userId] = {
    status: "JOINED", // JOINED | DECLINED | REJECTED
    tier, // MAIN | SUB
    name,
    at,
    present: null,
    eligibleAtMinus5: false,
    rejectedReason: null,
  };

  return { ok: true, tier };
}

function applyReject(eventObj, userId, name, reason) {
  const prev = eventObj.rsvp?.[userId];
  const at = prev?.at || Date.now();
  eventObj.rsvp[userId] = {
    status: "REJECTED",
    tier: null,
    name: name || prev?.name || "Unknown",
    at,
    present: null,
    eligibleAtMinus5: prev?.eligibleAtMinus5 || false,
    rejectedReason: reason || "REJECTED",
  };
}

function applyDecline(eventObj, userId, name) {
  const prev = eventObj.rsvp?.[userId];
  const at = prev?.at || Date.now();
  eventObj.rsvp[userId] = {
    status: "DECLINED",
    tier: null,
    name,
    at,
    present: null,
    eligibleAtMinus5: prev?.eligibleAtMinus5 || false,
    rejectedReason: null,
  };
}



function applyRemove(eventObj, userId) {
  if (eventObj.rsvp?.[userId]) delete eventObj.rsvp[userId];
}

// ================== GROUPING FOR EMBED ==================
function groupLists(eventObj) {
  const main = [];
  const sub = [];
  const rejected = [];
  const declined = [];

  const entries = Object.entries(eventObj.rsvp || {}).sort(
    (a, b) => (a[1].at || 0) - (b[1].at || 0)
  );

  for (const [uid, info] of entries) {
    const line = `• <@${uid}>`;

    if (info.status === "DECLINED") {
      declined.push(line);
      continue;
    }

    if (info.status === "REJECTED") {
      rejected.push(line);
      continue;
    }

    if (info.status === "JOINED") {
      if (info.tier === "MAIN") main.push(line);
      else if (info.tier === "SUB") sub.push(line);
    }
  }

  return { main, sub, rejected, declined };
}

// ================== ATTENDANCE (اختياري جاهز للربط بالفويس) ==================
// حسب كلامك: إذا ما كان موجود قبل 5 دقائق من بداية الإيفنت → Not Present عند البداية.
// (حالياً نفعّلها بشكل آلي: snapshot عند T-5 + check عند Start)

async function snapshotEligibleMinus5(client, rosterId) {
  const eventsDB = loadEventsDB();
  const ev = eventsDB.events?.[rosterId];
  if (!ev) return;

  const typeCfg = getTypeCfg(ev.typeId);
  if (!typeCfg?.voiceChannelId) return;

  try {
    const voiceCh = await client.channels.fetch(typeCfg.voiceChannelId);
    if (!voiceCh || voiceCh.type !== ChannelType.GuildVoice) return;

    const membersInVoice = new Set([...voiceCh.members.keys()]);

    for (const [uid, info] of Object.entries(ev.rsvp || {})) {
      if (info.status === "JOINED" && (info.tier === "MAIN" || info.tier === "SUB")) {
        info.eligibleAtMinus5 = membersInVoice.has(uid);

        // شرط -5 دقائق: لازم يكون بالفويس، وإلا Rejected (MAIN + SUB)
        if (!info.eligibleAtMinus5) {
          applyReject(ev, uid, info.name, "NOT_IN_VOICE_MINUS5");
        }
      }
    }

    saveEventsDB(eventsDB);

    // حدّث رسالة الروستر بعد الفحص
    const typeCfg2 = getTypeCfg(ev.typeId);
    if (typeCfg2 && ev.rosterMessageId) {
      try { await ensureRosterMessage(client, ev, typeCfg2); } catch {}
    }
  } catch (e) {
    console.error("snapshotEligibleMinus5 error:", e);
  }
}

async function markAttendanceAtStart(client, rosterId) {
  const eventsDB = loadEventsDB();
  const ev = eventsDB.events?.[rosterId];
  if (!ev) return;

  const typeCfg = getTypeCfg(ev.typeId);
  if (!typeCfg?.voiceChannelId) return;

  try {
    const voiceCh = await client.channels.fetch(typeCfg.voiceChannelId);
    if (!voiceCh || voiceCh.type !== ChannelType.GuildVoice) return;

    const membersInVoice = new Set([...voiceCh.members.keys()]);

    for (const [uid, info] of Object.entries(ev.rsvp || {})) {
      if (info.status === "JOINED" && (info.tier === "MAIN" || info.tier === "SUB")) {
        // لازم كان موجود عند -5 دقائق + موجود عند البداية
        const eligible = !!info.eligibleAtMinus5;
        const inNow = membersInVoice.has(uid);
        info.present = eligible && inNow;
      }
    }

    saveEventsDB(eventsDB);

    // حدّث الروستر بعد تحديد الحضور
    const typeCfg2 = getTypeCfg(ev.typeId);
    if (typeCfg2 && ev.rosterMessageId) {
      await ensureRosterMessage(client, ev, typeCfg2);
    // Apply attendee role if configured
    await applyAttendanceRoleAtStart(client, rosterId);
    }
  } catch (e) {
    console.error("markAttendanceAtStart error:", e);
  }
}


// ================== ATTENDANCE ROLE (اختياري) ==================
// إذا تم تحديد attendeeRoleId داخل الروستر (من الويزارد):
// - نعطي الرول للحاضرين (present=true) عند بداية الروستر
// - ونشيل الرول بعد نهاية الروستر (اختياري وآمن)
async function applyAttendanceRoleAtStart(client, rosterId) {
  const eventsDB = loadEventsDB();
  const ev = eventsDB.events?.[rosterId];
  if (!ev) return;

  const roleId = ev?.event?.attendeeRoleId;
  if (!roleId) return;

  try {
    const guild = client.guilds.cache.get(ev.guildId) || (await client.guilds.fetch(ev.guildId).catch(() => null));
    if (!guild) return;

    for (const [uid, info] of Object.entries(ev.rsvp || {})) {
      if (info.status === "JOINED" && info.tier === "MAIN" && info.present === true) {
        const member = await guild.members.fetch(uid).catch(() => null);
        if (!member) continue;
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId).catch(() => null);
        }
      }
    }
  } catch (e) {
    console.error("applyAttendanceRoleAtStart error:", e);
  }
}

async function removeAttendanceRoleAtEnd(client, rosterId) {
  const eventsDB = loadEventsDB();
  const ev = eventsDB.events?.[rosterId];
  if (!ev) return;

  const roleId = ev?.event?.attendeeRoleId;
  if (!roleId) return;

  try {
    const guild = client.guilds.cache.get(ev.guildId) || (await client.guilds.fetch(ev.guildId).catch(() => null));
    if (!guild) return;

    // نشيل الرول من كل اللي كانوا مسجلين بالروستر فقط (آمن، ما يلمس بقية السيرفر)
    for (const uid of Object.keys(ev.rsvp || {})) {
      const member = await guild.members.fetch(uid).catch(() => null);
      if (!member) continue;
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId).catch(() => null);
      }
    }
  } catch (e) {
    console.error("removeAttendanceRoleAtEnd error:", e);
  }
}

// ================== REPEATS (اختياري) ==================
function computeNextStartIso(currentStartIso, repeats) {
  const r = String(repeats || "None");
  const dt = DateTime.fromISO(currentStartIso).setZone(timeZone);
  if (!dt.isValid) return null;

  if (r === "Daily") return dt.plus({ days: 1 }).toISO();
  if (r === "Weekly") return dt.plus({ days: 7 }).toISO();
  if (r === "Every30Min") return dt.plus({ minutes: 30 }).toISO();
  if (r === "Every60Min") return dt.plus({ minutes: 60 }).toISO();
  if (r === "Every120Min") return dt.plus({ minutes: 120 }).toISO();
  return null;
}

function cloneEventForRepeat(prevEv, nextStartIso) {
  const durationMin = Math.max(1, Number(prevEv?.event?.durationMin) || Math.round((new Date(prevEv.event.endIso).getTime() - new Date(prevEv.event.startIso).getTime()) / 60000) || 60);
  const nextStartDt = DateTime.fromISO(nextStartIso).setZone(timeZone);
  const nextEndIso = nextStartDt.plus({ minutes: durationMin }).toISO();

  const rosterId = genRosterId();
  return normalizeRosterRecord({
    rosterId,
    guildId: prevEv.guildId,
    typeId: prevEv.typeId,
    status: "SCHEDULED",
    creatorId: prevEv.creatorId,
    remindersMinutes: Array.from(new Set(prevEv.remindersMinutes || [20, 10, 0])),
    event: {
      title: prevEv.event.title,
      description: prevEv.event.description,
      startIso: nextStartIso,
      endIso: nextEndIso,
      mainLimit: prevEv.event.mainLimit,
      subLimit: prevEv.event.subLimit,
      closeBeforeMin: Number(prevEv.event.closeBeforeMin) || 0,
      repeats: prevEv.event.repeats || "None",
      attendeeRoleId: prevEv.event.attendeeRoleId || null,
      durationMin,
    },
    rosterMessageId: null,
    rosterMessageUrl: null,
    announceMessageIds: [],
    rsvp: {},
  }, rosterId);
}
// ================== EMBED DESIGN B ==================
function fmtList(arr) {
  return arr.length ? arr.join("\n") : "—";
}

function minutesToStart(startMs) {
  const diffMs = startMs - nowMs();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (60 * 1000)); // بالدقائق فقط
}

function buildRosterEmbed(eventObj, typeCfg) {
  const { title, description, startIso, endIso, mainLimit, subLimit } = eventObj.event;

  const startU = toUnix(startIso);
  const endU = toUnix(endIso);
  const closeMin = Number(eventObj?.event?.closeBeforeMin);
  const closeU = startU ? startU - (Number.isFinite(closeMin) ? closeMin : 0) * 60 : null;

  const closed = isClosed(eventObj);
  const startMs = new Date(startIso).getTime();
  const closeMs = startMs - (Number.isFinite(closeMin) ? closeMin : 0) * 60 * 1000;

  const mins = minutesToStart(startMs);
  const minsToClose = minutesToStart(closeMs);
  const countdownLine =
    minsToClose === null
      ? ""
      : minsToClose === 0
      ? "⏳ **Closes now**"
      : `⏳ **Closes in:** ${minsToClose} minute(s)`;

  // Single status line (Starting now -> Closed automatically)
  const statusLine = closed ? "🔴 **Closed**" : mins === 0 ? "🟢 **Starting now**" : "";

  const { main, sub, rejected } = groupLists(eventObj);

  const mainCount = main.length;
  const subCount = sub.length;

  const timeBlock =
    startU && endU
      ? [
          `**Time (UTC)**`,
          `<t:${startU}:F> - <t:${endU}:t>`,
          `**Closes at:** <t:${closeU}:t>`,
          statusLine,
          // Show countdown only before start (avoid noisy relative lines)
          !closed && minsToClose !== null && minsToClose > 0 ? countdownLine : "",
        ]
          .filter(Boolean)
          .join("\n")
      : `**Time (UTC)**\nInvalid time (fix via Edit)`;

  const embed = new EmbedBuilder()
    .setTitle(title || "Roster")
    .setDescription([description || "—", "", `**Type:** \`${typeCfg?.typeId || eventObj.typeId}\``]
      .filter(Boolean)
      .join("\n"))
    .addFields(
      { name: " ", value: timeBlock },
      { name: `🟦 MAIN (${mainCount}/${mainLimit})`, value: fmtList(main) },
      { name: `🟪 SUB (${subCount}/${subLimit})`, value: fmtList(sub) },
      { name: `⛔ Rejected (${rejected.length})`, value: fmtList(rejected) }
    )
    .setFooter({ text: `RosterId: ${eventObj.rosterId}` })
    .setTimestamp();

  return embed;
}

function buildButtons(eventObj) {
  const closed = isClosed(eventObj);
  const rid = eventObj.rosterId;
  const cid = (a) => `roster:${rid}:${a}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid("join"))
      .setStyle(ButtonStyle.Success)
      .setLabel("Join")
      .setEmoji("✅")
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId(cid("decline"))
      .setStyle(ButtonStyle.Danger)
      .setLabel("Decline")
      .setEmoji("❌")
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId(cid("remove"))
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Remove")
      .setEmoji("🧹"),
    new ButtonBuilder()
      .setCustomId(cid("edit"))
      .setStyle(ButtonStyle.Primary)
      .setLabel("Edit"),
    new ButtonBuilder()
      .setCustomId(cid("delete"))
      .setStyle(ButtonStyle.Danger)
      .setLabel("Delete")
  );
}

// ================== MESSAGE OPS ==================
async function ensureRosterMessage(client, eventObj, typeCfg) {
  const rosterChannel = await client.channels.fetch(typeCfg.rosterChannelId);
  if (!rosterChannel || rosterChannel.type !== ChannelType.GuildText) {
    throw new Error("Roster channel invalid");
  }

  if (eventObj.rosterMessageId) {
    try {
      const msg = await rosterChannel.messages.fetch(eventObj.rosterMessageId);
      await msg.edit({
        embeds: [buildRosterEmbed(eventObj, typeCfg)],
        components: [buildButtons(eventObj)],
        allowedMentions: { parse: [] },
      });
      return msg;
    } catch {
      eventObj.rosterMessageId = null;
      eventObj.rosterMessageUrl = null;
    }
  }

  const msg = await rosterChannel.send({
    embeds: [buildRosterEmbed(eventObj, typeCfg)],
    components: [buildButtons(eventObj)],
    allowedMentions: { parse: [] },
  });

  eventObj.rosterMessageId = msg.id;
  eventObj.rosterMessageUrl = msg.url;
  return msg;
}

async function sendAnnouncement(client, eventObj, typeCfg, label) {
  const announceChannel = await client.channels.fetch(typeCfg.announceChannelId);
  if (!announceChannel || announceChannel.type !== ChannelType.GuildText) {
    throw new Error("Announce channel invalid");
  }

  const mention = typeCfg.mentionRoleId ? `<@&${typeCfg.mentionRoleId}>` : "";
  const startU = toUnix(eventObj.event.startIso);

  const embed = new EmbedBuilder()
    .setTitle(`📣 ${label}: ${eventObj.event.title || "Roster"}`)
    .setDescription(
      [
        eventObj.event.description || "",
        startU ? `🕒 Starts: <t:${startU}:F> (<t:${startU}:R>)` : "",
        eventObj.rosterMessageUrl ? `🔗 Roster: ${eventObj.rosterMessageUrl}` : "",
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: `RosterId: ${eventObj.rosterId}` })
    .setTimestamp();

  await announceChannel.send({
    content: mention,
    embeds: [embed],
    allowedMentions: {
      roles: typeCfg.mentionRoleId ? [typeCfg.mentionRoleId] : [],
    },
  });
}

// ================== WIZARD DRAFTS (EPHEMERAL) ==================
// Drafts are kept in-memory (reset on bot restart). Key = userId
const wizardDrafts = new Map();
const typeDrafts = new Map();

const WIZARD_DEFAULTS = {
  title: "Roster",
  description: "",
  startDay: 1,       // Mon (Luxon weekday 1..7)
  startHour: 0,      // 0..23
  startMinute: 0,    // 0..59
  durationMin: 60,
  repeats: "None",   // None | Daily | Weekly | Every30Min | Every60Min | Every120Min
  mainLimit: 10,
  subLimit: 10,
  mentionMode: "None", // None | Everyone | Role
  mentionRoleId: null,
  restrictions: "—",
  color: "Default",
  multiSignups: "Disabled",
  attendeeRoleId: null,
  closeBeforeMin: 5,
  reminders: "20,10,0",
  imageUrl: null,
};

function getOrCreateDraft(userId, typeId) {
  const norm = normalizeTypeId(typeId);
  const prev = wizardDrafts.get(userId);
  if (prev && prev.typeId === norm) return prev;

  const typeCfg = getTypeCfg(norm);
  const d = { ...WIZARD_DEFAULTS, userId, typeId: norm };

  // Defaults from type
  if (typeCfg?.typeId) d.title = String(typeCfg.typeId);
  const defMain = Number(typeCfg?.defaultMainLimit);
  const defSub = Number(typeCfg?.defaultSubLimit);
  const defDur = Number(typeCfg?.defaultDurationMin);
  if (Number.isFinite(defMain)) d.mainLimit = Math.max(0, Math.min(200, defMain));
  if (Number.isFinite(defSub)) d.subLimit = Math.max(0, Math.min(200, defSub));
  if (Number.isFinite(defDur)) d.durationMin = Math.max(15, Math.min(600, defDur));

  const defClose = Number(typeCfg?.closeBeforeMin);
  if (Number.isFinite(defClose)) d.closeBeforeMin = Math.max(0, Math.min(180, defClose));

  wizardDrafts.set(userId, d);
  return d;
}

function fmtStartLine(d) {
  const dayName = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.startDay] || "—";
  const hh = String(d.startHour).padStart(2, "0");
  const mm = String(d.startMinute).padStart(2, "0");
  return `${dayName} ${hh}:${mm} (UTC)`;
}

function fmtClosesAtLine(d) {
  const startIso = getEventTime(d.startDay, d.startHour, d.startMinute);
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return "—";
  const closeMin = Number(d.closeBeforeMin);
  const closeMs = startMs - (Number.isFinite(closeMin) ? closeMin : 0) * 60 * 1000;
  const closeIso = new Date(closeMs).toISOString();
  const dt = DateTime.fromISO(closeIso).setZone(timeZone);
  return dt.toFormat("ccc HH:mm 'UTC'");
}

function buildWizardEmbed(d, typeCfg) {
  const lines = [
    "**What would you like to modify?**",
    "",
    `**1 - Title**\n${d.title || "—"}`,
    "",
    `**2 - Description**\n${d.description ? d.description : "—"}`,
    "",
    `**3 - Start Time (UTC)**\n${fmtStartLine(d)}`,
    "",
    `**4 - Duration**\n${d.durationMin} minutes`,
    "",
    `**5 - Repeats (optional)**\n${d.repeats || "None"}`,
    "",
    `**6 - Signup options**\nMAIN ${d.mainLimit} | SUB ${d.subLimit}`,
    "",
    `**7 - Event mentions**\n${d.mentionMode === "Role" && d.mentionRoleId ? `<@&${d.mentionRoleId}>` : d.mentionMode}`,
    "",
    `**8 - Event restrictions**\n${d.restrictions || "—"}`,
    "",
    `**9 - Color**\n${d.color || "Default"}`,
    "",
    `**10 - Multiple signups**\n${d.multiSignups || "Disabled"}`,
    "",
    `**11 - Attendee role (optional)**\n${d.attendeeRoleId ? `<@&${d.attendeeRoleId}>` : "—"}`,
    "",
    `**12 - Closes at / before (UTC)**\n${d.closeBeforeMin} minutes before start (UTC)`,
    "",
    `**13 - Reminders**\n${d.reminders || "—"}`,
    "",
    `**14 - Image (optional)**\n${d.imageUrl ? d.imageUrl : "—"}`,
    "",
    `**Type:** \`${typeCfg?.typeId || d.typeId}\``,
  ];

  return new EmbedBuilder()
    .setTitle("Roster Wizard")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Select an option below • UTC time" })
    .setTimestamp();
}

function buildWizardMainComponents(d) {
  const fieldSelect = new StringSelectMenuBuilder()
    .setCustomId(`wiz:${d.userId}:${d.typeId}:field`)
    .setPlaceholder("Select what to modify")
    .addOptions(
      { label: "1 - Title", value: "title" },
      { label: "2 - Description", value: "description" },
      { label: "3 - Start Day (UTC)", value: "start_day" },
      { label: "3 - Start Hour (UTC)", value: "start_hour" },
      { label: "3 - Start Minute (UTC)", value: "start_minute" },
      { label: "4 - Duration", value: "duration" },
      { label: "5 - Repeats (optional)", value: "repeats" },
      { label: "6 - Main/Sub limits", value: "limits" },
      { label: "7 - Event mentions", value: "mentions" },
      { label: "11 - Attendee role (optional)", value: "attendee_role" },
      { label: "12 - Closes at / before", value: "close_before" },
      { label: "13 - Reminders", value: "reminders" },
      { label: "14 - Image (optional)", value: "image" },
    );

  const row1 = new ActionRowBuilder().addComponents(fieldSelect);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wiz:${d.userId}:${d.typeId}:publish`).setStyle(ButtonStyle.Success).setLabel("Publish"),
    new ButtonBuilder().setCustomId(`wiz:${d.userId}:${d.typeId}:cancel`).setStyle(ButtonStyle.Danger).setLabel("Cancel"),
  );

  return [row1, row2];
}

const WIZ_DAY_CHOICES = [
  { label: "Mon", value: "1" },
  { label: "Tue", value: "2" },
  { label: "Wed", value: "3" },
  { label: "Thu", value: "4" },
  { label: "Fri", value: "5" },
  { label: "Sat", value: "6" },
  { label: "Sun", value: "7" },
];

function buildPickerComponents(d, kind) {
  if (kind === "start_day") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:start_day`)
      .setPlaceholder("Pick start day (UTC)")
      .addOptions(...WIZ_DAY_CHOICES);
    return [new ActionRowBuilder().addComponents(menu)];
  }
  if (kind === "start_hour") {
    const opts = Array.from({ length: 24 }, (_, i) => ({ label: String(i).padStart(2, "0"), value: String(i) }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:start_hour`)
      .setPlaceholder("Pick start hour (UTC)")
      .addOptions(...opts.slice(0, 25));
    return [new ActionRowBuilder().addComponents(menu)];
  }
  if (kind === "start_minute") {
    const opts = Array.from({ length: 60 }, (_, i) => ({ label: String(i).padStart(2, "0"), value: String(i) }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:start_minute`)
      .setPlaceholder("Pick start minute (UTC)")
      .addOptions(...opts.slice(0, 25));
    const menu2 = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick2:start_minute`)
      .setPlaceholder("More minutes (UTC)")
      .addOptions(...opts.slice(25, 50));
    const menu3 = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick3:start_minute`)
      .setPlaceholder("More minutes (UTC)")
      .addOptions(...opts.slice(50));
    return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(menu2), new ActionRowBuilder().addComponents(menu3)];
  }
  if (kind === "duration") {
    const opts = [15,20,25,30,45,60,75,90,120,180].map(n=>({ label: `${n} minutes`, value: String(n)}));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:duration`)
      .setPlaceholder("Pick duration")
      .addOptions(...opts);
    return [new ActionRowBuilder().addComponents(menu)];
  }
  if (kind === "repeats") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:repeats`)
      .setPlaceholder("Pick repeat")
      .addOptions(
        { label: "None", value: "None" },
        { label: "Daily", value: "Daily" },
        { label: "Weekly", value: "Weekly" },
        { label: "Every 30 minutes", value: "Every30Min" },
        { label: "Every 1 hour", value: "Every60Min" },
        { label: "Every 2 hours", value: "Every120Min" },
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }
  if (kind === "close_before") {
    const opts = [0,1,2,3,5,10,15,20,30].map(n=>({ label: n===0?"At start":"Before start: "+n+" min", value: String(n)}));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:close_before`)
      .setPlaceholder("Pick closes-before minutes")
      .addOptions(...opts);
    return [new ActionRowBuilder().addComponents(menu)];
  }
  return [];
}

function buildRosterMentionsComponents(d) {
  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId(`wiz:${d.userId}:${d.typeId}:pick:mention_mode`)
    .setPlaceholder("Pick mention mode")
    .addOptions(
      { label: "None", value: "None" },
      { label: "Everyone", value: "Everyone" },
      { label: "Role", value: "Role" },
    );

  const rows = [new ActionRowBuilder().addComponents(modeMenu)];

  if (d.mentionMode === "Role") {
    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`wizrole:${d.userId}:${d.typeId}:mention_role`)
      .setPlaceholder("Select mention role")
      .setMinValues(0)
      .setMaxValues(1);
    rows.push(new ActionRowBuilder().addComponents(roleSelect));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wiz:${d.userId}:${d.typeId}:clear_mention_role`).setStyle(ButtonStyle.Secondary).setLabel("Clear Mention Role"),
  ));

  return rows;
}

function buildRosterAttendeeRoleComponents(d) {
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`wizrole:${d.userId}:${d.typeId}:attendee_role`)
    .setPlaceholder("Select attendee role (optional)")
    .setMinValues(0)
    .setMaxValues(1);

  return [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wiz:${d.userId}:${d.typeId}:clear_attendee_role`).setStyle(ButtonStyle.Secondary).setLabel("Clear Attendee Role"),
    ),
  ];
}


// ================== TYPE WIZARD ==================
const TYPE_DEFAULTS = {
  typeId: "",
  displayName: "",
  rosterChannelId: "",
  announceChannelId: "",
  voiceChannelId: "",
  mentionRoleId: "",
  closeBeforeMin: 5,
  requireRole: false,
  mainRoleIds: [],
  subRoleIds: [],
  defaultMainLimit: 10,
  defaultSubLimit: 10,
  defaultDurationMin: 60,
};

function getOrCreateTypeDraft(userId, typeId, existing) {
  const key = normalizeTypeId(typeId);
  const prev = typeDrafts.get(userId);
  if (prev && prev.typeId === key) return prev;

  const d = { ...TYPE_DEFAULTS, ...normalizeTypeCfg(existing || {}, key), userId, typeId: key };
  typeDrafts.set(userId, d);
  return d;
}

function buildTypeWizardEmbed(d) {
  const lines = [
    "**Type Setup Wizard**",
    "",
    `**Type Name:** ${d.displayName || "—"}`,
    `**Internal Key:** \`${d.typeId || "—"}\``,
    "",
    `**Roster Channel:** ${d.rosterChannelId ? `<#${d.rosterChannelId}>` : "—"}`,
    `**Announce Channel:** ${d.announceChannelId ? `<#${d.announceChannelId}>` : "—"}`,
    `**Voice Channel:** ${d.voiceChannelId ? `<#${d.voiceChannelId}>` : "—"}`,
    "",
    `**Mention Role:** ${d.mentionRoleId ? `<@&${d.mentionRoleId}>` : "—"}`,
    `**Closes before (minutes):** ${d.closeBeforeMin}`,
    `**Default Main slots:** ${d.defaultMainLimit}`,
    `**Default Sub slots:** ${d.defaultSubLimit}`,
    `**Default Duration (min):** ${d.defaultDurationMin}`,
    `**Require Role:** ${d.requireRole ? "ON" : "OFF"}${(!d.mainRoleIds.length && !d.subRoleIds.length) ? " (auto OFF if no roles)" : ""}`,
    "",
    `**Main Roles:** ${d.mainRoleIds.length ? d.mainRoleIds.map((id) => `<@&${id}>`).join(" ") : "—"}`,
    `**Sub Roles:** ${d.subRoleIds.length ? d.subRoleIds.map((id) => `<@&${id}>`).join(" ") : "—"}`,
    "",
    "Use the Discord menus below to pick channels and roles directly.",
    "Use **Edit Fields** only for name, limits, duration, and closes-before.",
  ];

  return new EmbedBuilder()
    .setTitle("Type Wizard")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Type Wizard • UTC" })
    .setTimestamp();
}

function buildTypeWizardComponents(d, page = "main") {
  if (page === "channels") {
    const rosterSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`wtypechan:${d.userId}:${d.typeId}:roster_channel`)
      .setPlaceholder("Pick roster channel")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1);

    const announceSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`wtypechan:${d.userId}:${d.typeId}:announce_channel`)
      .setPlaceholder("Pick announce channel")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1);

    const voiceSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`wtypechan:${d.userId}:${d.typeId}:voice_channel`)
      .setPlaceholder("Pick voice channel")
      .setChannelTypes(ChannelType.GuildVoice)
      .setMinValues(1)
      .setMaxValues(1);

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:view_main`).setStyle(ButtonStyle.Secondary).setLabel("Back"),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:save`).setStyle(ButtonStyle.Success).setLabel("Save Type"),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:cancel`).setStyle(ButtonStyle.Danger).setLabel("Cancel"),
    );

    return [
      new ActionRowBuilder().addComponents(rosterSelect),
      new ActionRowBuilder().addComponents(announceSelect),
      new ActionRowBuilder().addComponents(voiceSelect),
      buttons,
    ];
  }

  if (page === "roles") {
    const mentionRoleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`wtyperole:${d.userId}:${d.typeId}:mention_role`)
      .setPlaceholder("Pick mention role (optional)")
      .setMinValues(0)
      .setMaxValues(1);

    const mainRolesSelect = new RoleSelectMenuBuilder()
      .setCustomId(`wtyperole:${d.userId}:${d.typeId}:main_roles`)
      .setPlaceholder("Pick MAIN roles")
      .setMinValues(0)
      .setMaxValues(25);

    const subRolesSelect = new RoleSelectMenuBuilder()
      .setCustomId(`wtyperole:${d.userId}:${d.typeId}:sub_roles`)
      .setPlaceholder("Pick SUB roles")
      .setMinValues(0)
      .setMaxValues(25);

    const row4 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:toggle_require`).setStyle(d.requireRole ? ButtonStyle.Success : ButtonStyle.Secondary).setLabel(`Require Role: ${d.requireRole ? "ON" : "OFF"}`),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:clear_mention`).setStyle(ButtonStyle.Secondary).setLabel("Clear Mention"),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:clear_main`).setStyle(ButtonStyle.Secondary).setLabel("Clear Main"),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:clear_sub`).setStyle(ButtonStyle.Secondary).setLabel("Clear Sub"),
    );

    const row5 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:view_main`).setStyle(ButtonStyle.Secondary).setLabel("Back"),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:save`).setStyle(ButtonStyle.Success).setLabel("Save Type"),
      new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:cancel`).setStyle(ButtonStyle.Danger).setLabel("Cancel"),
    );

    return [
      new ActionRowBuilder().addComponents(mentionRoleSelect),
      new ActionRowBuilder().addComponents(mainRolesSelect),
      new ActionRowBuilder().addComponents(subRolesSelect),
      row4,
      row5,
    ];
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`wtype:${d.userId}:${d.typeId}:field:${d._msgId || "0"}`)
    .setPlaceholder("Edit fields")
    .addOptions(
      { label: "Type Name", value: "display_name" },
      { label: "Closes before (minutes)", value: "close_before" },
      { label: "Default Main slots", value: "def_main" },
      { label: "Default Sub slots", value: "def_sub" },
      { label: "Default Duration (minutes)", value: "def_duration" },
    );

  const row1 = new ActionRowBuilder().addComponents(select);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:view_channels`).setStyle(ButtonStyle.Primary).setLabel("Channels"),
    new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:view_roles`).setStyle(ButtonStyle.Primary).setLabel("Roles"),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:save`).setStyle(ButtonStyle.Success).setLabel("Save Type"),
    new ButtonBuilder().setCustomId(`wtype:${d.userId}:${d.typeId}:cancel`).setStyle(ButtonStyle.Danger).setLabel("Cancel"),
  );

  return [row1, row2, row3];
}

// ================== TIMERS ==================
const timers = new Map();

function clearTimer(key) {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.delete(key);
}

function setTimer(key, delayMs, fn) {
  clearTimer(key);
  timers.set(key, setTimeout(fn, Math.max(0, delayMs)));
}

async function runReminder(client, rosterId, minutes) {
  const eventsDB = loadEventsDB();
  const eventObj = eventsDB.events?.[rosterId];
  if (!eventObj) return;

  const typeCfg = getTypeCfg(eventObj.typeId);
  if (!typeCfg) return;

  const endMs = new Date(eventObj.event.endIso).getTime();
  if (Number.isFinite(endMs) && nowMs() > endMs) {
    eventObj.status = "CLOSED";
    saveEventsDB(eventsDB);
    return;
  }

  const reminderTimes = computeReminderTimesMs(eventObj.event.startIso, eventObj.remindersMinutes);
  const first = reminderTimes.length ? reminderTimes[0].minutes : null;
  const isFirstReminder = first !== null && minutes === first;

  if (isFirstReminder) {
    eventObj.status = "ACTIVE";
    const rosterMsg = await ensureRosterMessage(client, eventObj, typeCfg);
    eventObj.rosterMessageUrl = rosterMsg.url;
  } else {
    if (eventObj.rosterMessageId) {
      try {
        await ensureRosterMessage(client, eventObj, typeCfg);
      } catch {}
    }
  }

  const label = minutes === 0 ? "Now" : `${minutes} min before`;
  await sendAnnouncement(client, eventObj, typeCfg, label);

  saveEventsDB(eventsDB);
}

function scheduleEventTimers(client, rosterId) {
  const eventsDB = loadEventsDB();
  const eventObj = eventsDB.events?.[rosterId];
  if (!eventObj) return;

  if (eventObj.status === "CLOSED") return;

  const startMs = new Date(eventObj.event.startIso).getTime();
  const endMs = new Date(eventObj.event.endIso).getTime();

  const times = computeReminderTimesMs(eventObj.event.startIso, eventObj.remindersMinutes);
  const effective = times.length ? times : [{ minutes: 0, atMs: startMs }];

  for (const t of effective) {
    const key = `rem:${rosterId}:${t.minutes}`;
    const delay = t.atMs - nowMs();

    if (delay <= 0) {
      setTimer(key, 10, () => runReminder(client, rosterId, t.minutes).catch(console.error));
    } else {
      setTimer(key, delay, () => runReminder(client, rosterId, t.minutes).catch(console.error));
    }
  }

  // snapshot attendance at -5 minutes
  if (Number.isFinite(startMs)) {
    const keyMinus5 = `attminus5:${rosterId}`;
    const delayMinus5 = (startMs - 5 * 60 * 1000) - nowMs();
    setTimer(keyMinus5, delayMinus5, () => snapshotEligibleMinus5(client, rosterId).catch(console.error));
  }

  // mark attendance at start
  if (Number.isFinite(startMs)) {
    const keyAttend = `attstart:${rosterId}`;
    const delayAttend = startMs - nowMs();
    setTimer(keyAttend, delayAttend, () => markAttendanceAtStart(client, rosterId).catch(console.error));
  }

  // update at start (disable buttons)
  if (Number.isFinite(startMs)) {
    const keyClose = `close:${rosterId}`;
    const delayClose = startMs - nowMs();
    setTimer(keyClose, delayClose, async () => {
      const eventsDB2 = loadEventsDB();
      const ev = eventsDB2.events?.[rosterId];
      if (!ev) return;
      try {
        const cfg = getTypeCfg(ev.typeId);
        if (cfg && ev.rosterMessageId) await ensureRosterMessage(client, ev, cfg);
      } catch {}
      saveEventsDB(eventsDB2);
    });
  }

  // close after end
  if (Number.isFinite(endMs)) {
    const keyEnd = `end:${rosterId}`;
    const delayEnd = endMs - nowMs();
    setTimer(keyEnd, delayEnd, () => {
      const db = loadEventsDB();
      const ev = db.events?.[rosterId];
      if (!ev) return;

      ev.status = "CLOSED";
      saveEventsDB(db);

      // schedule next roster if repeats enabled
      const nextStartIso = computeNextStartIso(ev.event.startIso, ev.event.repeats);
      if (nextStartIso) {
        const nextEv = cloneEventForRepeat(ev, nextStartIso);
        const db2 = loadEventsDB();
        db2.events[nextEv.rosterId] = nextEv;
        saveEventsDB(db2);
        scheduleEventTimers(client, nextEv.rosterId);
      }
    });
  }
}

function rescheduleAll(client) {
  const eventsDB = loadEventsDB();
  for (const rosterId of Object.keys(eventsDB.events || {})) {
    scheduleEventTimers(client, rosterId);
  }
}

// ================== SAFE REPLY HELPERS ==================
async function safeDefer(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferReply({ ephemeral: true }); // بدل flags
    return true;
  } catch {
    return false;
  }
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred) {
      return await interaction.editReply(content);
    }
    if (interaction.replied) {
      return await interaction.followUp({ content, ephemeral: true });
    }
    return await interaction.reply({ content, ephemeral: true });
  } catch (e) {
    console.error("safeReply error:", e);
  }
}

// ================== COMMAND HANDLER ==================
async function handleCommand(interaction) {
  await safeDefer(interaction);

  const cmd = interaction.commandName;


// ===== roster_wizard (UTC day/hour/minute via select menus) =====
if (cmd === "roster_wizard") {
  if (!canCreateRoster(interaction.member) && !canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

  const typeOpt = interaction.options.getString("type");
  if (!typeOpt) {
    const embed = new EmbedBuilder()
      .setTitle("Roster Wizard")
      .setDescription(`Choose what you want to do:

• Create Type
• Edit Type
• Create Roster
• Manage Types

All times are **UTC**.`)
      .setFooter({ text: "Wizard Menu • UTC" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wizroot:${interaction.user.id}:create_type`).setStyle(ButtonStyle.Primary).setLabel("Create Type"),
      new ButtonBuilder().setCustomId(`wizroot:${interaction.user.id}:edit_type`).setStyle(ButtonStyle.Secondary).setLabel("Edit Type"),
      new ButtonBuilder().setCustomId(`wizroot:${interaction.user.id}:create_roster`).setStyle(ButtonStyle.Success).setLabel("Create Roster"),
      new ButtonBuilder().setCustomId(`wizroot:${interaction.user.id}:manage_types`).setStyle(ButtonStyle.Danger).setLabel("Manage Types"),
    );

    return interaction.editReply({ embeds: [embed], components: [row] });
  }

  const typeId = normalizeTypeId(typeOpt);
  const typeCfg = getTypeCfg(typeId);
  if (!typeCfg) return safeReply(interaction, `❌ النوع \`${typeOpt.trim()}\` غير موجود. افتح /roster_wizard بدون type وسوِّ Create Type.`);
  if (!canCreateRoster(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية إنشاء روستر.");

  const d = getOrCreateDraft(interaction.user.id, typeId);

  return interaction.editReply({
    embeds: [buildWizardEmbed(d, typeCfg)],
    components: buildWizardMainComponents(d),
  });
}

  // ===== roster_type_setup =====
  if (cmd === "roster_type_setup") {
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = normalizeTypeId(interaction.options.getString("type", true));
    const rosterChannel = interaction.options.getChannel("roster_channel", true);
    const announceChannel = interaction.options.getChannel("announce_channel", true);
    const voiceChannel = interaction.options.getChannel("voice_channel", true);
    const mentionRole = interaction.options.getRole("mention_role");
    const closeBeforeMinOpt = interaction.options.getInteger("close_before_min");

    if (rosterChannel.type !== ChannelType.GuildText || announceChannel.type !== ChannelType.GuildText) {
      return safeReply(interaction, "❌ لازم تختار Text Channels فقط (للروستر والإعلان).");
    }
    if (voiceChannel.type !== ChannelType.GuildVoice) {
      return safeReply(interaction, "❌ لازم تختار Voice Channel للحضور.");
    }

    const types = loadTypesDB();
    types.types[typeId] = normalizeTypeCfg(types.types[typeId] || { typeId }, typeId);

    types.types[typeId].typeId = typeId;
    types.types[typeId].displayName = sanitizeTypeName(types.types[typeId].displayName || typeId);
    types.types[typeId].rosterChannelId = rosterChannel.id;
    types.types[typeId].announceChannelId = announceChannel.id;
    types.types[typeId].voiceChannelId = voiceChannel.id;
    types.types[typeId].mentionRoleId = mentionRole ? mentionRole.id : (types.types[typeId].mentionRoleId || null);
    if (Number.isFinite(Number(closeBeforeMinOpt))) types.types[typeId].closeBeforeMin = clampInt(closeBeforeMinOpt, 5, 0, 180);
    types.types[typeId] = normalizeTypeCfg(types.types[typeId], typeId);

    saveTypesDB(types);

    return safeReply(
      interaction,
      `✅ تم إعداد النوع \`${typeId}\`\n` +
        `- Roster Channel: <#${rosterChannel.id}>\n` +
        `- Announce Channel: <#${announceChannel.id}>\n` +
        `- Voice Channel: <#${voiceChannel.id}>\n` +
        `- Mention Role: ${types.types[typeId].mentionRoleId ? `<@&${types.types[typeId].mentionRoleId}>` : "None"}\n` +
        `- Main Roles: ${types.types[typeId].mainRoleIds.length ? types.types[typeId].mainRoleIds.map(id => `<@&${id}>`).join(" ") : "—"}`
    );
  }

  // ===== main roles add/remove =====
  if (cmd === "roster_type_main_add" || cmd === "roster_type_main_remove") {
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = normalizeTypeId(interaction.options.getString("type", true));
    const role = interaction.options.getRole("role", true);

    const types = loadTypesDB();
    const t = types.types?.[typeId];
    if (!t) return safeReply(interaction, `❌ النوع \`${typeId}\` غير موجود. استخدم /roster_type_setup`);

    t.mainRoleIds = t.mainRoleIds || [];
    const set = new Set(t.mainRoleIds);

    if (cmd.endsWith("_add")) set.add(role.id);
    else set.delete(role.id);

    t.mainRoleIds = Array.from(set);
    saveTypesDB(types);

    return safeReply(
      interaction,
      `✅ تم تحديث Main Roles للنوع \`${typeId}\`.\n` +
        `الآن: ${t.mainRoleIds.length ? t.mainRoleIds.map((id) => `<@&${id}>`).join(" ") : "—"}`
    );
  }

  // ===== sub roles add/remove =====
  if (cmd === "roster_type_sub_add" || cmd === "roster_type_sub_remove") {
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = normalizeTypeId(interaction.options.getString("type", true));
    const role = interaction.options.getRole("role", true);

    const types = loadTypesDB();
    const t = types.types?.[typeId];
    if (!t) return safeReply(interaction, `❌ النوع \`${typeId}\` غير موجود. استخدم /roster_type_setup`);

    t.subRoleIds = t.subRoleIds || [];
    const set = new Set(t.subRoleIds);

    if (cmd.endsWith("_add")) set.add(role.id);
    else set.delete(role.id);

    t.subRoleIds = Array.from(set);
    saveTypesDB(types);

    return safeReply(
      interaction,
      `✅ تم تحديث Sub Roles للنوع \`${typeId}\`.\n` +
        `الآن: ${t.subRoleIds.length ? t.subRoleIds.map((id) => `<@&${id}>`).join(" ") : "—"}`
    );
  }

  // ===== require role toggle =====
  if (cmd === "roster_type_require_role") {
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = normalizeTypeId(interaction.options.getString("type", true));
    const enabled = interaction.options.getBoolean("enabled", true);

    const types = loadTypesDB();
    const t = types.types?.[typeId];
    if (!t) return safeReply(interaction, `❌ النوع \`${typeId}\` غير موجود. استخدم /roster_type_setup`);

    const hasAnyRolePool = (t.mainRoleIds?.length || 0) > 0 || (t.subRoleIds?.length || 0) > 0;
    if (enabled && !hasAnyRolePool) {
      t.requireRole = false;
      saveTypesDB(types);
      return safeReply(interaction, `⚠️ ما أقدر أشغل Require Role للنوع \`${typeId}\` لأن Main/Sub Roles فاضية. أضف رول واحد على الأقل أول.`);
    }

    t.requireRole = !!enabled;
    types.types[typeId] = normalizeTypeCfg(t, typeId);
    saveTypesDB(types);

    return safeReply(interaction, `✅ Require Role للنوع \`${typeId}\` صار: **${types.types[typeId].requireRole ? "ON" : "OFF"}**`);
  }

  // ===== delete type =====
  if (cmd === "roster_type_delete") {
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = normalizeTypeId(interaction.options.getString("type", true));
    const typesDB = loadTypesDB();

    if (!typesDB.types?.[typeId]) return safeReply(interaction, `❌ النوع \`${typeId}\` غير موجود.`);

    delete typesDB.types[typeId];
    saveTypesDB(typesDB);

    return safeReply(interaction, `✅ تم حذف إعدادات النوع \`${typeId}\`.`);
  }

  // ===== roster_schedule (day/hour/min) =====
  if (cmd === "roster_schedule") {
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = normalizeTypeId(interaction.options.getString("type", true));
    const title = interaction.options.getString("title", true).trim();
    const desc = interaction.options.getString("description")?.trim() || "";

    const startDay = interaction.options.getInteger("start_day", true);
    const startHour = interaction.options.getInteger("start_hour", true);
    const startMinute = interaction.options.getInteger("start_minute", true);

    const endDay = interaction.options.getInteger("end_day", true);
    const endHour = interaction.options.getInteger("end_hour", true);
    const endMinute = interaction.options.getInteger("end_minute", true);

    const mainLimit = interaction.options.getInteger("main_limit", true);
    const subLimit = interaction.options.getInteger("sub_limit", true);

    const remindersRaw = interaction.options.getString("reminders", true).trim(); // "20,10,0"

    const typeCfg = getTypeCfg(typeId);
    if (!typeCfg) return safeReply(interaction, `❌ النوع \`${typeId}\` غير موجود. استخدم /roster_type_setup`);

    const startIso = getEventTime(startDay, startHour, startMinute);
    const endIso = getEventTime(endDay, endHour, endMinute);

    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return safeReply(interaction, "❌ وقت غير صحيح. تأكد end > start.");
    }
    if (mainLimit < 0 || mainLimit > 200 || subLimit < 0 || subLimit > 200) {
      return safeReply(interaction, "❌ Limits لازم تكون بين 0 و 200.");
    }

    const remindersMinutes = parseRemindersList(remindersRaw, []);

    if (!remindersMinutes.length) {
      return safeReply(interaction, "❌ reminders لازم تكون مثل: 20,10 أو 10 أو 20,10,0");
    }

    const rosterId = genRosterId();

    const eventsDB = loadEventsDB();
    eventsDB.events[rosterId] = buildRosterRecord({
      rosterId,
      guildId: interaction.guildId,
      creatorId: interaction.user.id,
      typeId,
      typeCfg,
      title,
      description: desc,
      startIso,
      endIso,
      mainLimit,
      subLimit,
      remindersMinutes,
      repeats: typeCfg?.repeats || "None",
      attendeeRoleId: typeCfg?.attendeeRoleId || null,
      closeBeforeMin: typeCfg?.closeBeforeMin,
    });

    saveEventsDB(eventsDB);
    scheduleEventTimers(client, rosterId);

    const startU = toUnix(startIso);
    const first = Math.max(...remindersMinutes);

    return safeReply(
      interaction,
      `✅ تم جدولة روستر جديد: \`${rosterId}\`\n` +
        `- Type: \`${typeId}\`\n` +
        `- Starts (UTC): ${startU ? `<t:${startU}:F> (<t:${startU}:R>)` : startIso}\n` +
        `- Main/Sub: **${mainLimit} / ${subLimit}**\n` +
        `- Reminders: **${remindersMinutes.sort((a, b) => b - a).join(", ")}** minutes\n` +
        `- Roster will be created at first reminder (**${first} min before**)`
    );
  }

  // ===== roster_list =====
  if (cmd === "roster_list") {
    if (!isController(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typeId = interaction.options.getString("type") ? normalizeTypeId(interaction.options.getString("type")) : null;
    const eventsDB = loadEventsDB();

    const all = Object.values(eventsDB.events || {});
    const filtered = typeId ? all.filter((e) => e.typeId === typeId) : all;
    filtered.sort((a, b) => new Date(b.event.startIso).getTime() - new Date(a.event.startIso).getTime());

    const top = filtered.slice(0, 10);
    if (!top.length) return safeReply(interaction, "— ما فيه روسترات.");

    const lines = top.map((e) => {
      const u = toUnix(e.event.startIso);
      return `• \`${e.rosterId}\` | \`${e.typeId}\` | ${e.status} | ${u ? `<t:${u}:R>` : e.event.startIso}`;
    });

    return safeReply(interaction, lines.join("\n"));
  }

  // ===== roster_delete (delete scheduled roster) =====
  if (cmd === "roster_delete") {
    if (!isController(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const rosterId = interaction.options.getString("roster_id", true).trim();
    const eventsDB = loadEventsDB();

    const ev = eventsDB.events?.[rosterId];
    if (!ev) return safeReply(interaction, "❌ roster_id غير موجود.");

    const typeCfg = getTypeCfg(ev.typeId);

    // حاول حذف رسالة الروستر إن وجدت
    if (typeCfg && ev.rosterMessageId) {
      try {
        const ch = await client.channels.fetch(typeCfg.rosterChannelId);
        const msg = await ch.messages.fetch(ev.rosterMessageId);
        await msg.delete();
      } catch {}
    }

    // نظف التايمرز المرتبطة
    for (const k of Array.from(timers.keys())) {
      if (k.includes(`:${rosterId}`)) clearTimer(k);
    }

    delete eventsDB.events[rosterId];
    saveEventsDB(eventsDB);

    return safeReply(interaction, `🗑️ تم حذف الروستر \`${rosterId}\` بالكامل.`);
  }

  // ===== roster_close / roster_reset / roster_kick =====
  if (cmd === "roster_close" || cmd === "roster_reset" || cmd === "roster_kick") {
    if (!isController(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const rosterId = interaction.options.getString("roster_id", true).trim();
    const eventsDB = loadEventsDB();
    const ev = eventsDB.events?.[rosterId];
    if (!ev) return safeReply(interaction, "❌ roster_id غير موجود.");

    const typeCfg = getTypeCfg(ev.typeId);
    if (!typeCfg) return safeReply(interaction, "❌ النوع المرتبط بهذا الروستر غير موجود.");

    if (cmd === "roster_close") {
      ev.status = "CLOSED";
      try {
        if (ev.rosterMessageId) await ensureRosterMessage(client, ev, typeCfg);
      } catch {}
      saveEventsDB(eventsDB);
      return safeReply(interaction, `✅ تم إغلاق الروستر \`${rosterId}\`.`);
    }

    if (cmd === "roster_reset") {
      ev.rsvp = {};
      try {
        if (ev.rosterMessageId) await ensureRosterMessage(client, ev, typeCfg);
      } catch {}
      saveEventsDB(eventsDB);
      return safeReply(interaction, `✅ تم Reset للروستر \`${rosterId}\`.`);
    }

    if (cmd === "roster_kick") {
      const user = interaction.options.getUser("user", true);
      if (ev.rsvp?.[user.id]) delete ev.rsvp[user.id];
      try {
        if (ev.rosterMessageId) await ensureRosterMessage(client, ev, typeCfg);
      } catch {}
      saveEventsDB(eventsDB);
      return safeReply(interaction, `✅ تم إزالة <@${user.id}> من \`${rosterId}\`.`);
    }
  }

  return safeReply(interaction, "❌ أمر غير معروف.");
}

// ================== BUTTONS & MODALS ==================
async function handleButtonsAndModals(interaction) {

// ===== ROOT WIZARD BUTTONS =====
  if (interaction.isButton && interaction.isButton()) {
    const cid = String(interaction.customId || "");
    const parts = cid.split(":");

    if (parts[0] === "wizroot") {
      const targetUserId = parts[1];
      const action = parts[2];

      if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");

      const typesDB = loadTypesDB();
      const typeKeys = Object.keys(typesDB.types || {}).slice(0, 25);

      if (action === "back") {
        const embed = new EmbedBuilder()
          .setTitle("Roster Wizard")
          .setDescription(`Choose what you want to do:

• Create Type
• Edit Type
• Create Roster
• Manage Types

All times are **UTC**.`)
          .setFooter({ text: "Wizard Menu • UTC" })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`wizroot:${targetUserId}:create_type`).setStyle(ButtonStyle.Primary).setLabel("Create Type"),
          new ButtonBuilder().setCustomId(`wizroot:${targetUserId}:edit_type`).setStyle(ButtonStyle.Secondary).setLabel("Edit Type"),
          new ButtonBuilder().setCustomId(`wizroot:${targetUserId}:create_roster`).setStyle(ButtonStyle.Success).setLabel("Create Roster"),
          new ButtonBuilder().setCustomId(`wizroot:${targetUserId}:manage_types`).setStyle(ButtonStyle.Danger).setLabel("Manage Types"),
        );

        return interaction.update({ embeds: [embed], components: [row] });
      }

      if (action === "create_type") {
        if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");
        const modal = new ModalBuilder()
          .setCustomId(`wtypecreate:${targetUserId}:${interaction.message.id}`)
          .setTitle("Create Type");

        const inp = new TextInputBuilder()
          .setCustomId("type")
          .setLabel("Type Name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Example: Informal Raid");

        modal.addComponents(new ActionRowBuilder().addComponents(inp));
        return interaction.showModal(modal);
      }

      if (action === "edit_type" || action === "create_roster") {
        if (action === "edit_type" && !canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");
        if (action === "create_roster" && !canCreateRoster(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية إنشاء روستر.");
        if (!typeKeys.length) return safeReply(interaction, "❌ ما فيه أنواع محفوظة. سوِّ Create Type أول.");

        const picker = new StringSelectMenuBuilder()
          .setCustomId(`wizpick:${targetUserId}:${action}`)
          .setPlaceholder("Pick a type")
          .addOptions(...typeKeys.map((k) => ({ label: typeDisplayLabel(k, typesDB.types?.[k]), value: k })));

        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`wizroot:${targetUserId}:back`).setStyle(ButtonStyle.Secondary).setLabel("Back"),
        );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle(action === "edit_type" ? "Pick a Type" : "Create Roster")
              .setDescription(action === "edit_type" ? "Select a type to continue." : "Pick a type to continue.")
              .setFooter({ text: "UTC" })
              .setTimestamp(),
          ],
          components: [new ActionRowBuilder().addComponents(picker), backRow],
        });
      }
    
      if (action === "manage_types") {
        if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`wizmanage:${targetUserId}`)
          .setPlaceholder("Choose an action")
          .addOptions(
            { label: "Delete Type", value: "delete_type" },
            { label: "Reset Type", value: "reset_type" },
            { label: "Reset ALL Types", value: "reset_all" },
          );

        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`wizroot:${targetUserId}:back`).setStyle(ButtonStyle.Secondary).setLabel("Back"),
        );

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("Type Manager")
              .setDescription("Choose what you want to do with types.")
              .setFooter({ text: "UTC" })
              .setTimestamp(),
          ],
          components: [new ActionRowBuilder().addComponents(menu), backRow],
        });
      }

      return safeReply(interaction, "❌ إجراء غير معروف.");
    }
  }


// ===== SELECT MENUS =====

if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
  const cid = String(interaction.customId || "");
  const parts = cid.split(":");

  // ===== TYPE MANAGER =====
  if (parts[0] === "wizmanage") {
    const targetUserId = parts[1];
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const action = interaction.values?.[0];
    const typesDB = loadTypesDB();
    const typeKeys = Object.keys(typesDB.types || {}).slice(0, 25);

    if (action === "reset_all") {
      const modal = new ModalBuilder()
        .setCustomId(`wtypeconfirm:${targetUserId}:reset_all:__all__:${interaction.message.id}`)
        .setTitle("Confirm Reset ALL Types");
      const inp = new TextInputBuilder()
        .setCustomId("v")
        .setLabel("Type RESET ALL to confirm")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(inp));
      return interaction.showModal(modal);
    }

    if (!typeKeys.length) return safeReply(interaction, "❌ ما فيه أنواع محفوظة.");

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wizmanpick:${targetUserId}:${action}`)
      .setPlaceholder("Pick a type")
      .addOptions(...typeKeys.map((k) => ({ label: typeDisplayLabel(k, typesDB.types?.[k]), value: k })));

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("Type Manager")
          .setDescription("Pick a type.")
          .setTimestamp(),
      ],
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }

  if (parts[0] === "wizmanpick") {
    const targetUserId = parts[1];
    const action = parts[2]; // delete_type | reset_type
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const chosenType = normalizeTypeId(interaction.values?.[0]);
    const modal = new ModalBuilder()
      .setCustomId(`wtypeconfirm:${targetUserId}:${action}:${chosenType}:${interaction.message.id}`)
      .setTitle("Confirm Action");

    const label = action === "delete_type" ? `Type DELETE ${chosenType} to confirm` : `Type RESET ${chosenType} to confirm`;
    const inp = new TextInputBuilder()
      .setCustomId("v")
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(inp));
    return interaction.showModal(modal);
  }

  // ===== ROOT TYPE PICKERS =====
  if (parts[0] === "wizpick") {
    const targetUserId = parts[1];
    const action = parts[2]; // edit_type | create_roster
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");

    const chosenType = normalizeTypeId(interaction.values?.[0]);

    if (action === "edit_type") {
      if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");
      const existing = getTypeCfg(chosenType);
      if (!existing) return safeReply(interaction, "❌ النوع غير موجود.");
      const d = getOrCreateTypeDraft(targetUserId, chosenType, existing);
      // store message id for modal edits
      d._msgId = interaction.message.id;
      typeDrafts.set(targetUserId, d);
      return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d) });
    }

    if (action === "create_roster") {
      if (!canCreateRoster(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية إنشاء روستر.");
      const cfg = getTypeCfg(chosenType);
      if (!cfg) return safeReply(interaction, "❌ النوع غير موجود.");
      const d = getOrCreateDraft(targetUserId, chosenType);
      return interaction.update({ embeds: [buildWizardEmbed(d, cfg)], components: buildWizardMainComponents(d) });
    }
    return safeReply(interaction, "❌ إجراء غير معروف.");
  }

  // ===== TYPE WIZARD SELECT =====
  if (parts[0] === "wtype") {
    const targetUserId = parts[1];
    const typeId = parts[2];
    const mode = parts[3]; // field
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const d = getOrCreateTypeDraft(targetUserId, typeId, getTypeCfg(typeId));
    d._msgId = interaction.message.id;

    const chosen = interaction.values?.[0];

    if (mode === "field") {
      if (chosen === "display_name") {
        const modal = new ModalBuilder()
          .setCustomId(`wtypemodal:${targetUserId}:${typeId}:${chosen}:${interaction.message.id}`)
          .setTitle("Type Wizard Edit");
        const inp = new TextInputBuilder()
          .setCustomId("v")
          .setLabel("Type Name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(d.displayName || d.typeId || "");
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
        return interaction.showModal(modal);
      }

      const modal = new ModalBuilder()
        .setCustomId(`wtypemodal:${targetUserId}:${typeId}:${chosen}:${interaction.message.id}`)
        .setTitle("Type Wizard Edit");

      const inp = new TextInputBuilder()
        .setCustomId("v")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      if (chosen === "close_before") inp.setLabel("Closes before minutes (0-180)").setValue(String(d.closeBeforeMin ?? 5));
      if (chosen === "def_main") inp.setLabel("Default Main slots (0-200)").setValue(String(d.defaultMainLimit ?? 10));
      if (chosen === "def_sub") inp.setLabel("Default Sub slots (0-200)").setValue(String(d.defaultSubLimit ?? 10));
      if (chosen === "def_duration") inp.setLabel("Default Duration minutes (15-600)").setValue(String(d.defaultDurationMin ?? 60));

      modal.addComponents(new ActionRowBuilder().addComponents(inp));
      return interaction.showModal(modal);
    }

    return safeReply(interaction, "❌ إجراء غير معروف.");
  }

  // ===== ROSTER WIZARD SELECT =====
  if (parts[0] !== "wiz") return;

  const targetUserId = parts[1];
  const typeId = parts[2];
  const mode = parts[3]; // field | pick | pick2 | pick3

  if (interaction.user.id !== targetUserId) {
    return safeReply(interaction, "❌ هذا الويزارد مو لك.");
  }

  const typeCfg = getTypeCfg(typeId);
  if (!typeCfg) return safeReply(interaction, "❌ إعدادات النوع غير موجودة.");

  const d = getOrCreateDraft(interaction.user.id, typeId);

  const chosen = interaction.values?.[0];

  if (mode === "field") {
    if (["start_day","start_hour","start_minute","duration","repeats","close_before"].includes(chosen)) {
      return interaction.update({
        embeds: [buildWizardEmbed(d, typeCfg)],
        components: buildPickerComponents(d, chosen).concat(buildWizardMainComponents(d)),
      });
    }

    if (chosen === "mentions") {
      return interaction.update({
        embeds: [buildWizardEmbed(d, typeCfg)],
        components: buildRosterMentionsComponents(d).concat(buildWizardMainComponents(d)),
      });
    }

    if (chosen === "attendee_role") {
      return interaction.update({
        embeds: [buildWizardEmbed(d, typeCfg)],
        components: buildRosterAttendeeRoleComponents(d).concat(buildWizardMainComponents(d)),
      });
    }

    if (chosen === "title" || chosen === "description" || chosen === "reminders" || chosen === "image" || chosen === "limits") {
      const modal = new ModalBuilder()
        .setCustomId(`wizmodal:${interaction.user.id}:${typeId}:${chosen}:${interaction.message.id}`)
        .setTitle("Wizard Edit");

      if (chosen === "title") {
        const inp = new TextInputBuilder().setCustomId("v").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setValue(d.title || "");
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
      } else if (chosen === "description") {
        const inp = new TextInputBuilder().setCustomId("v").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(d.description || "");
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
      } else if (chosen === "reminders") {
        const inp = new TextInputBuilder().setCustomId("v").setLabel('Reminders CSV (e.g. "20,10,0")').setStyle(TextInputStyle.Short).setRequired(true).setValue(d.reminders || "20,10,0");
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
      } else if (chosen === "image") {
        const inp = new TextInputBuilder().setCustomId("v").setLabel("Image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(d.imageUrl || "");
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
      } else if (chosen === "limits") {
        const m1 = new TextInputBuilder().setCustomId("main").setLabel("Main limit (0-200)").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(d.mainLimit ?? 0));
        const m2 = new TextInputBuilder().setCustomId("sub").setLabel("Sub limit (0-200)").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(d.subLimit ?? 0));
        modal.addComponents(new ActionRowBuilder().addComponents(m1), new ActionRowBuilder().addComponents(m2));
      }

      return interaction.showModal(modal);
    }

    return interaction.update({
      embeds: [buildWizardEmbed(d, typeCfg)],
      components: buildWizardMainComponents(d),
    });
  }

  const pickerKind = parts[4];
  if (mode.startsWith("pick")) {
    if (pickerKind === "start_day") d.startDay = Number(chosen);
    if (pickerKind === "start_hour") d.startHour = Number(chosen);
    if (pickerKind === "start_minute") d.startMinute = Number(chosen);
    if (pickerKind === "duration") d.durationMin = Number(chosen);
    if (pickerKind === "repeats") d.repeats = String(chosen);
    if (pickerKind === "close_before") d.closeBeforeMin = Number(chosen);
    if (pickerKind === "mention_mode") {
      d.mentionMode = ["None", "Everyone", "Role"].includes(String(chosen)) ? String(chosen) : "None";
      if (d.mentionMode !== "Role") d.mentionRoleId = null;
    }

    wizardDrafts.set(interaction.user.id, d);

    return interaction.update({
      embeds: [buildWizardEmbed(d, typeCfg)],
      components: buildWizardMainComponents(d),
    });
  }
}



// ===== MODALS =====
if (interaction.isModalSubmit && interaction.isModalSubmit()) {
  const cid = String(interaction.customId || "");
  const parts = cid.split(":");

  // ===== ROSTER WIZARD MODAL =====
  if (parts[0] === "wizmodal") {
    const targetUserId = parts[1];
    const typeId = parts[2];
    const field = parts[3];
    const messageId = parts[4];

    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");

    const typeCfg = getTypeCfg(typeId);
    if (!typeCfg) return safeReply(interaction, "❌ إعدادات النوع غير موجودة.");

    const d = getOrCreateDraft(interaction.user.id, typeId);

    if (field === "title") d.title = interaction.fields.getTextInputValue("v")?.trim() || "Roster";
    if (field === "description") d.description = interaction.fields.getTextInputValue("v")?.trim() || "";
    if (field === "reminders") d.reminders = interaction.fields.getTextInputValue("v")?.trim() || "20,10,0";
    if (field === "image") d.imageUrl = interaction.fields.getTextInputValue("v")?.trim() || null;

    if (field === "limits") {
      const main = Number(interaction.fields.getTextInputValue("main")?.trim());
      const sub = Number(interaction.fields.getTextInputValue("sub")?.trim());
      if (!Number.isFinite(main) || main < 0 || main > 200) return safeReply(interaction, "❌ Main limit لازم 0-200.");
      if (!Number.isFinite(sub) || sub < 0 || sub > 200) return safeReply(interaction, "❌ Sub limit لازم 0-200.");
      d.mainLimit = main;
      d.subLimit = sub;
    }


    wizardDrafts.set(interaction.user.id, d);

    try {
      const ch = await interaction.client.channels.fetch(interaction.channelId);
      const msg = await ch.messages.fetch(messageId);
      await msg.edit({ embeds: [buildWizardEmbed(d, typeCfg)], components: buildWizardMainComponents(d) });
    } catch {}

    return safeReply(interaction, "✅ تم التحديث.");
  }

  // ===== TYPE WIZARD CREATE TYPE ID MODAL =====
  if (parts[0] === "wtypecreate") {
    const targetUserId = parts[1];

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }

      if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
      if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

      const rawName = sanitizeTypeName(interaction.fields.getTextInputValue("type"));
      if (!rawName) return safeReply(interaction, "❌ Type Name مطلوب.");

      const typesDB = loadTypesDB();
      const typeId = makeUniqueTypeIdFromName(rawName, typesDB.types || {});

      const d = getOrCreateTypeDraft(targetUserId, typeId, { typeId, displayName: rawName });
      d.displayName = rawName;
      typeDrafts.set(targetUserId, d);

      return interaction.editReply({
        content: `✅ فتحنا Type Wizard للنوع **${rawName}**. عدّل الإعدادات ثم اضغط Save Type.`,
        embeds: [buildTypeWizardEmbed(d)],
        components: buildTypeWizardComponents(d),
      });
    } catch (e) {
      console.error("wtypecreate submit error:", e);
      return safeReply(interaction, "❌ صار خطأ أثناء إنشاء النوع. جرّب مرة ثانية.");
    }
  }

    // ===== TYPE MANAGER CONFIRM MODAL =====
  if (parts[0] === "wtypeconfirm") {
    const targetUserId = parts[1];
    const action = parts[2];
    const typeId = parts[3];
    const messageId = parts[4];

    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const typed = String(interaction.fields.getTextInputValue("v") || "").trim();

    const types = loadTypesDB();

    if (action === "reset_all") {
      if (typed !== "RESET ALL") return safeReply(interaction, "❌ اكتب RESET ALL للتأكيد.");
      types.types = {};
      saveTypesDB(types);
      return safeReply(interaction, "✅ تم Reset ALL للأنواع.");
    }

    const key = normalizeTypeId(typeId);
    if (!types.types?.[key]) return safeReply(interaction, "❌ النوع غير موجود.");

    if (action === "delete_type") {
      if (typed !== `DELETE ${key}`) return safeReply(interaction, `❌ اكتب DELETE ${key} للتأكيد.`);
      delete types.types[key];
      saveTypesDB(types);
      return safeReply(interaction, `✅ تم حذف النوع \`${key}\`.`);
    }

    if (action === "reset_type") {
      if (typed !== `RESET ${key}`) return safeReply(interaction, `❌ اكتب RESET ${key} للتأكيد.`);
      const prev = types.types[key] || {};
      // Reset non-identity fields, keep channels/roles? We'll fully reset to safe defaults but keep channels if present.
      types.types[key] = {
        typeId: key,
        rosterChannelId: prev.rosterChannelId || "",
        announceChannelId: prev.announceChannelId || "",
        voiceChannelId: prev.voiceChannelId || "",
        mentionRoleId: prev.mentionRoleId || null,
        closeBeforeMin: 5,
        requireRole: false,
        mainRoleIds: Array.from(new Set(prev.mainRoleIds || [])),
        subRoleIds: Array.from(new Set(prev.subRoleIds || [])),
        defaultMainLimit: 10,
        defaultSubLimit: 10,
        defaultDurationMin: 60,
      };
      saveTypesDB(types);
      return safeReply(interaction, `✅ تم Reset للنوع \`${key}\`.`);
    }

    return safeReply(interaction, "❌ إجراء غير معروف.");
  }

// ===== TYPE WIZARD EDIT FIELD MODAL =====
  if (parts[0] === "wtypemodal") {
    const targetUserId = parts[1];
    const typeId = parts[2];
    const field = parts[3];
    const messageId = parts[4];

    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const d = getOrCreateTypeDraft(targetUserId, typeId, getTypeCfg(typeId));
    const v = interaction.fields.getTextInputValue("v");

    if (field === "display_name") {
      const name = sanitizeTypeName(v);
      if (!name) return safeReply(interaction, "❌ Type Name مطلوب.");
      d.displayName = name;
    }
    if (field === "roster_channel") d.rosterChannelId = parseIdFromMentionOrId(v);
    if (field === "announce_channel") d.announceChannelId = parseIdFromMentionOrId(v);
    if (field === "voice_channel") d.voiceChannelId = parseIdFromMentionOrId(v);
    if (field === "mention_role") d.mentionRoleId = parseIdFromMentionOrId(v);
    if (field === "close_before") {
      const n = Number(String(v || "").trim());
      if (!Number.isFinite(n) || n < 0 || n > 180) return safeReply(interaction, "❌ close_before_min لازم 0-180.");
      d.closeBeforeMin = n;
    }
    if (field === "main_roles") d.mainRoleIds = Array.from(new Set(parseIdsCsv(v)));
    if (field === "sub_roles") d.subRoleIds = Array.from(new Set(parseIdsCsv(v)));
    if (field === "def_main") {
      const n = Number(String(v || "").trim());
      if (!Number.isFinite(n) || n < 0 || n > 200) return safeReply(interaction, "❌ defaultMainLimit لازم 0-200.");
      d.defaultMainLimit = n;
    }
    if (field === "def_sub") {
      const n = Number(String(v || "").trim());
      if (!Number.isFinite(n) || n < 0 || n > 200) return safeReply(interaction, "❌ defaultSubLimit لازم 0-200.");
      d.defaultSubLimit = n;
    }
    if (field === "def_duration") {
      const n = Number(String(v || "").trim());
      if (!Number.isFinite(n) || n < 15 || n > 600) return safeReply(interaction, "❌ defaultDurationMin لازم 15-600.");
      d.defaultDurationMin = n;
    }


    typeDrafts.set(targetUserId, d);

    try {
      const ch = await interaction.client.channels.fetch(interaction.channelId);
      const msg = await ch.messages.fetch(messageId);
      await msg.edit({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d) });
    } catch {}

    return safeReply(interaction, "✅ تم التحديث.");
  }
}

if ((interaction.isChannelSelectMenu && interaction.isChannelSelectMenu()) || (interaction.isRoleSelectMenu && interaction.isRoleSelectMenu())) {
  const cid = String(interaction.customId || "");
  const parts = cid.split(":");

  if (parts[0] === "wizrole") {
    const targetUserId = parts[1];
    const typeId = parts[2];
    const field = parts[3];
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");

    const typeCfg = getTypeCfg(typeId);
    if (!typeCfg) return safeReply(interaction, "❌ إعدادات النوع غير موجودة.");

    const d = getOrCreateDraft(targetUserId, typeId);
    const selectedId = interaction.values?.[0] ? String(interaction.values[0]).trim() : null;

    if (field === "mention_role") {
      d.mentionMode = "Role";
      d.mentionRoleId = selectedId || null;
      wizardDrafts.set(targetUserId, d);
      return interaction.update({ embeds: [buildWizardEmbed(d, typeCfg)], components: buildRosterMentionsComponents(d).concat(buildWizardMainComponents(d)) });
    }

    if (field === "attendee_role") {
      d.attendeeRoleId = selectedId || null;
      wizardDrafts.set(targetUserId, d);
      return interaction.update({ embeds: [buildWizardEmbed(d, typeCfg)], components: buildRosterAttendeeRoleComponents(d).concat(buildWizardMainComponents(d)) });
    }
  }

  if (parts[0] === "wtypechan") {
    const targetUserId = parts[1];
    const typeId = parts[2];
    const field = parts[3];
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const d = getOrCreateTypeDraft(targetUserId, typeId, getTypeCfg(typeId));
    const selectedId = interaction.values?.[0] ? String(interaction.values[0]).trim() : "";

    if (field === "roster_channel") d.rosterChannelId = selectedId;
    if (field === "announce_channel") d.announceChannelId = selectedId;
    if (field === "voice_channel") d.voiceChannelId = selectedId;

    typeDrafts.set(targetUserId, d);
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "channels") });
  }

  if (parts[0] === "wtyperole") {
    const targetUserId = parts[1];
    const typeId = parts[2];
    const field = parts[3];
    if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
    if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

    const d = getOrCreateTypeDraft(targetUserId, typeId, getTypeCfg(typeId));
    const roleIds = Array.from(new Set((interaction.values || []).map((x) => String(x || "").trim()).filter(Boolean)));

    if (field === "mention_role") d.mentionRoleId = roleIds[0] || null;
    if (field === "main_roles") d.mainRoleIds = roleIds;
    if (field === "sub_roles") d.subRoleIds = roleIds;
    if (!d.mainRoleIds.length && !d.subRoleIds.length) d.requireRole = false;

    typeDrafts.set(targetUserId, d);
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "roles") });
  }
}

  const eventsDB = loadEventsDB();

  if (interaction.isButton()) {

// ===== TYPE WIZARD BUTTONS =====

if (String(interaction.customId || "").startsWith("wtype:")) {
  const parts = interaction.customId.split(":");
  const targetUserId = parts[1];
  const typeId = parts[2];
  const action = parts[3];

  if (interaction.user.id !== targetUserId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");
  if (!canEditType(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية.");

  const d = getOrCreateTypeDraft(targetUserId, typeId, getTypeCfg(typeId));

  if (action === "cancel") {
    typeDrafts.delete(targetUserId);
    return interaction.update({ content: "🗑️ تم إلغاء Type Wizard.", embeds: [], components: [] });
  }

  if (action === "view_channels") {
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "channels") });
  }

  if (action === "view_roles") {
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "roles") });
  }

  if (action === "view_main") {
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "main") });
  }

  if (action === "toggle_require") {
    if (!d.mainRoleIds.length && !d.subRoleIds.length) {
      d.requireRole = false;
      typeDrafts.set(targetUserId, d);
      return safeReply(interaction, "❌ ما تقدر تفعل Require Role بدون Main/Sub roles.");
    }
    d.requireRole = !d.requireRole;
    typeDrafts.set(targetUserId, d);
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "roles") });
  }

  if (action === "clear_mention") {
    d.mentionRoleId = null;
    typeDrafts.set(targetUserId, d);
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "roles") });
  }

  if (action === "clear_main") {
    d.mainRoleIds = [];
    if (!d.mainRoleIds.length && !d.subRoleIds.length) d.requireRole = false;
    typeDrafts.set(targetUserId, d);
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "roles") });
  }

  if (action === "clear_sub") {
    d.subRoleIds = [];
    if (!d.mainRoleIds.length && !d.subRoleIds.length) d.requireRole = false;
    typeDrafts.set(targetUserId, d);
    return interaction.update({ embeds: [buildTypeWizardEmbed(d)], components: buildTypeWizardComponents(d, "roles") });
  }

  if (action === "save") {
    if (!d.typeId) return safeReply(interaction, "❌ Type Key مفقود.");
    if (!d.rosterChannelId || !d.announceChannelId || !d.voiceChannelId) {
      return safeReply(interaction, "❌ لازم تحدد Roster/Announce/Voice channels.");
    }

    const types = loadTypesDB();
    types.types[d.typeId] = normalizeTypeCfg({
      typeId: d.typeId,
      displayName: d.displayName || d.typeId,
      rosterChannelId: d.rosterChannelId,
      announceChannelId: d.announceChannelId,
      voiceChannelId: d.voiceChannelId,
      mentionRoleId: d.mentionRoleId || null,
      closeBeforeMin: d.closeBeforeMin,
      requireRole: !!d.requireRole,
      mainRoleIds: Array.from(new Set(d.mainRoleIds || [])),
      subRoleIds: Array.from(new Set(d.subRoleIds || [])),
      defaultMainLimit: d.defaultMainLimit,
      defaultSubLimit: d.defaultSubLimit,
      defaultDurationMin: d.defaultDurationMin,
    }, d.typeId);

    saveTypesDB(types);
    typeDrafts.delete(targetUserId);

    return interaction.update({
      content: `✅ تم حفظ النوع **${d.displayName || d.typeId}** بنجاح.
- Key: \`${d.typeId}\``,
      embeds: [],
      components: [],
    });
  }

  return safeReply(interaction, "❌ إجراء غير معروف.");
}


// ===== WIZARD BUTTONS =====
if (String(interaction.customId || "").startsWith("wiz:")) {
  const parts = interaction.customId.split(":");
  const userId = parts[1];
  const typeId = parts[2];
  const action = parts[3];

  if (interaction.user.id !== userId) return safeReply(interaction, "❌ هذا الويزارد مو لك.");

  const typeCfg = getTypeCfg(typeId);
  if (!typeCfg) return safeReply(interaction, "❌ إعدادات النوع غير موجودة.");

  const d = getOrCreateDraft(userId, typeId);

  if (action === "cancel") {
    wizardDrafts.delete(userId);
    return interaction.update({ content: "🗑️ تم إلغاء الويزارد.", embeds: [], components: [] });
  }

  if (action === "clear_mention_role") {
    d.mentionRoleId = null;
    if (d.mentionMode === "Role") d.mentionMode = "None";
    wizardDrafts.set(userId, d);
    return interaction.update({ embeds: [buildWizardEmbed(d, typeCfg)], components: buildRosterMentionsComponents(d).concat(buildWizardMainComponents(d)) });
  }

  if (action === "clear_attendee_role") {
    d.attendeeRoleId = null;
    wizardDrafts.set(userId, d);
    return interaction.update({ embeds: [buildWizardEmbed(d, typeCfg)], components: buildRosterAttendeeRoleComponents(d).concat(buildWizardMainComponents(d)) });
  }

  if (action === "publish") {
    // Validate basics
    const startIso = getEventTime(d.startDay, d.startHour, d.startMinute);
    const startDt = DateTime.fromISO(startIso).setZone(timeZone);
    const endIso = startDt.plus({ minutes: Number(d.durationMin) || 60 }).toISO();

    const mainLimit = clampInt(d.mainLimit, 10, 0, 200);
    const subLimit = clampInt(d.subLimit, 10, 0, 200);

    const remindersMinutes = parseRemindersList(d.reminders, []);

    if (!remindersMinutes.length) return safeReply(interaction, "❌ Reminders غير صحيحة. مثال: 20,10,0");

    const rosterId = genRosterId();
    const eventsDB = loadEventsDB();
    const typeCfg = getTypeCfg(typeId);

    eventsDB.events[rosterId] = buildRosterRecord({
      rosterId,
      guildId: interaction.guildId,
      creatorId: interaction.user.id,
      typeId,
      typeCfg,
      title: d.title || "Roster",
      description: d.description || "",
      startIso,
      endIso,
      mainLimit,
      subLimit,
      remindersMinutes,
      repeats: d.repeats,
      attendeeRoleId: d.attendeeRoleId,
      closeBeforeMin: d.closeBeforeMin,
    });

    saveEventsDB(eventsDB);
    scheduleEventTimers(client, rosterId);
    wizardDrafts.delete(userId);

    const startU = toUnix(startIso);
    const first = Math.max(...remindersMinutes);

    return interaction.update({
      content:
        `✅ تم إنشاء الروستر من الويزارد: \`${rosterId}\`\n` +
        `- Type: \`${typeId}\`\n` +
        `- Starts (UTC): ${startU ? `<t:${startU}:F> (<t:${startU}:R>)` : startIso}\n` +
        `- Duration: **${Number(d.durationMin) || 60}** min\n` +
        `- Main/Sub: **${mainLimit} / ${subLimit}**\n` +
        `- Reminders: **${remindersMinutes.sort((a, b) => b - a).join(", ")}** min\n` +
        `- Roster will be created at first reminder (**${first} min before**)`,
      embeds: [],
      components: [],
    });
  }

  return safeReply(interaction, "❌ إجراء غير معروف.");
}

    const [prefix, rosterId, action] = interaction.customId.split(":");
    if (prefix !== "roster" || !rosterId || !action) return;

    const ev = eventsDB.events?.[rosterId];
    if (!ev) {
      return safeReply(interaction, "❌ هذا الروستر غير موجود.");
    }

    const typeCfg = getTypeCfg(ev.typeId);
    if (!typeCfg) {
      return safeReply(interaction, "❌ إعدادات النوع غير موجودة.");
    }

    const member = interaction.member;
    const name = normalizeName(member, interaction.user);

    // main roles check
    const hasMainRole =
      (typeCfg.mainRoleIds || []).some((rid) => member?.roles?.cache?.has?.(rid));

    const closed = isClosed(ev);

    if (action === "join") {
      if (closed) return safeReply(interaction, "🔒 التسجيل مقفل.");

      const hasSubRole = (typeCfg.subRoleIds || []).some((rid) => member?.roles?.cache?.has?.(rid));

      const res = applyJoin(ev, interaction.user.id, name, {
        hasMainRole,
        hasSubRole,
        requireRole: !!typeCfg.requireRole,
      });
      saveEventsDB(eventsDB);

      try {
        if (ev.rosterMessageId) await ensureRosterMessage(client, ev, typeCfg);
      } catch {}

      if (!res.ok) {
        if (res.reason === "MISSING_ROLE") return safeReply(interaction, "❌ لازم يكون عندك رتبة (Main/Sub) عشان تسجل.");
        if (res.reason === "FULL") return safeReply(interaction, "❌ الروستر ممتلئ.");
        return safeReply(interaction, "❌ ما قدرنا نسجلك.");
      }
      if (res.tier === "MAIN") return safeReply(interaction, "🟦 دخلت **MAIN** ✅");
      if (res.tier === "SUB") return safeReply(interaction, "🟪 دخلت **SUB** ✅");
      return safeReply(interaction, "✅ تم تسجيلك.");
    }

    if (action === "decline") {
      if (closed) return safeReply(interaction, "🔒 التسجيل مقفل.");
      applyDecline(ev, interaction.user.id, name);
      saveEventsDB(eventsDB);
      try {
        if (ev.rosterMessageId) await ensureRosterMessage(client, ev, typeCfg);
      } catch {}
      return safeReply(interaction, "❌ تم وضعك Declined.");
    }

    if (action === "remove") {
      applyRemove(ev, interaction.user.id);
      saveEventsDB(eventsDB);
      try {
        if (ev.rosterMessageId) await ensureRosterMessage(client, ev, typeCfg);
      } catch {}
      return safeReply(interaction, "🧹 تم إزالة اسمك من الروستر.");
    }

    // Admin buttons
    if (action === "edit") {
      if (!isController(member)) return safeReply(interaction, "❌ ما عندك صلاحية تعديل.");

      const modal = new ModalBuilder()
        .setCustomId(`roster_edit:${rosterId}`)
        .setTitle("Edit Roster");

      const titleInput = new TextInputBuilder()
        .setCustomId("title")
        .setLabel("Title")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(ev.event.title || "Roster");

      const descInput = new TextInputBuilder()
        .setCustomId("desc")
        .setLabel("Description")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(ev.event.description || "");

      const mainLimitInput = new TextInputBuilder()
        .setCustomId("mainLimit")
        .setLabel("Main limit (0-200)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(ev.event.mainLimit ?? 0));

      const subLimitInput = new TextInputBuilder()
        .setCustomId("subLimit")
        .setLabel("Sub limit (0-200)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(ev.event.subLimit ?? 0));

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(mainLimitInput),
        new ActionRowBuilder().addComponents(subLimitInput)
      );

      return interaction.showModal(modal);
    }

    if (action === "delete") {
      if (!isController(member)) return safeReply(interaction, "❌ ما عندك صلاحية حذف.");

      // حذف الرسالة فقط + إغلاق
      try {
        if (ev.rosterMessageId) {
          const ch = await client.channels.fetch(typeCfg.rosterChannelId);
          const msg = await ch.messages.fetch(ev.rosterMessageId);
          await msg.delete();
        }
      } catch {}

      ev.rosterMessageId = null;
      ev.rosterMessageUrl = null;
      ev.status = "CLOSED";

      saveEventsDB(eventsDB);
      return safeReply(interaction, `🗑️ تم حذف رسالة الروستر وإغلاقه: \`${rosterId}\``);
    }
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("roster_edit:")) {
    const rosterId = interaction.customId.split(":")[1];

    const eventsDB2 = loadEventsDB();
    const ev = eventsDB2.events?.[rosterId];
    if (!ev) return safeReply(interaction, "❌ هذا الروستر غير موجود.");

    if (!isController(interaction.member)) return safeReply(interaction, "❌ ما عندك صلاحية تعديل.");

    const title = interaction.fields.getTextInputValue("title")?.trim();
    const desc = interaction.fields.getTextInputValue("desc")?.trim();
    const mainLimitRaw = interaction.fields.getTextInputValue("mainLimit")?.trim();
    const subLimitRaw = interaction.fields.getTextInputValue("subLimit")?.trim();

    const mainLimit = Number(mainLimitRaw);
    const subLimit = Number(subLimitRaw);

    if (!title) return safeReply(interaction, "❌ Title مطلوب.");
    if (!Number.isFinite(mainLimit) || mainLimit < 0 || mainLimit > 200) return safeReply(interaction, "❌ Main limit لازم 0-200.");
    if (!Number.isFinite(subLimit) || subLimit < 0 || subLimit > 200) return safeReply(interaction, "❌ Sub limit لازم 0-200.");

    ev.event.title = title;
    ev.event.description = desc || "";
    ev.event.mainLimit = mainLimit;
    ev.event.subLimit = subLimit;

    saveEventsDB(eventsDB2);

    try {
      const cfg = getTypeCfg(ev.typeId);
      if (cfg && ev.rosterMessageId) await ensureRosterMessage(client, ev, cfg);
    } catch {}

    return safeReply(interaction, "✅ تم تحديث الروستر.");
  }
}


// ================== CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
});


client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const userId = newState.id;
    const leftChannelId = oldState.channelId;
    const joinedChannelId = newState.channelId;

    // نهتم فقط إذا ترك/نقل من قناة
    if (!leftChannelId || leftChannelId === joinedChannelId) return;

    const now = Date.now();
    const db = loadEventsDB();
    let touched = false;

    for (const ev of Object.values(db.events || {})) {
      if (!ev?.event?.startIso) continue;
      const cfg = getTypeCfg(ev.typeId);
      if (!cfg?.voiceChannelId) continue;

      // فقط إذا ترك قناة الفويس الخاصة بهذا النوع
      if (cfg.voiceChannelId !== leftChannelId) continue;

      const startMs = new Date(ev.event.startIso).getTime();
      if (!Number.isFinite(startMs)) continue;

      const holdUntil = startMs + HOLD_MINUTES_AFTER_START * 60 * 1000;
      if (now < startMs || now > holdUntil) continue;

      const info = ev.rsvp?.[userId];
      if (!info) continue;

      if (info.status === "JOINED" && (info.tier === "MAIN" || info.tier === "SUB")) {
        applyReject(ev, userId, info.name, "LEFT_VOICE_WITHIN_HOLD");
        touched = true;
        try {
          if (ev.rosterMessageId) await ensureRosterMessage(client, ev, cfg);
        } catch {}
      }
    }

    if (touched) saveEventsDB(db);
  } catch (e) {
    console.error("voiceStateUpdate error:", e);
  }
});

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  rescheduleAll(client);

  // تحديث كل دقيقة (لـ countdown بالدقائق + حالة OPEN/CLOSED)
  setInterval(async () => {
    const eventsDB = loadEventsDB();
    const typesDB = loadTypesDB();

    for (const ev of Object.values(eventsDB.events || {})) {
      if (!ev.rosterMessageId) continue;
      const typeCfg = typesDB.types?.[ev.typeId];
      if (!typeCfg) continue;
      try {
        await ensureRosterMessage(client, ev, typeCfg);
      } catch {}
    }
  }, 60 * 1000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return handleCommand(interaction);
    if (interaction.isButton() || interaction.isModalSubmit() || (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) || (interaction.isChannelSelectMenu && interaction.isChannelSelectMenu()) || (interaction.isRoleSelectMenu && interaction.isRoleSelectMenu())) return handleButtonsAndModals(interaction);
  } catch (e) {
    console.error("interaction error:", e);
    // حاول ترد لو تقدر
    if (interaction.isRepliable()) {
      await safeReply(interaction, "❌ صار خطأ. شيّك الكونسل.");
    }
  }
});

client.login(TOKEN);
