require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "storage", "db.json");
const CONFIG_FILE = path.join(__dirname, "storage", "config.json");
const MAX_TEXT_LENGTH = 600;
const DISCORD_TIMEOUT_MS = 5 * 1000;
const DISCORD_WEBHOOK_NAME_DEFAULT = "Wunsch-Pinnwand";
const DISCORD_TITEL_DEFAULT = "Neuer Wunsch";
const DISCORD_NACHRICHT_DEFAULT = "{wunsch}";
const DISCORD_NACHRICHT_LEGACY_DEFAULT = "**Neuer Wunsch**\n{wunsch}";
const DISCORD_FARBE_DEFAULT = "#f2c94c";
const DISCORD_WEBHOOK_NAME_MAX = 80;
const DISCORD_TITEL_MAX = 256;
const DISCORD_NACHRICHT_MAX = 1000;
let discordKonfiguration = null;

// Angehängte Bilder landen neben der Datenbank und werden ausgeliefert
const BILD_ORDNER = path.join(__dirname, "storage", "bilder");
const MAX_BILD_BYTES = 3 * 1024 * 1024;
const BILD_ENDUNGEN = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Extrem toleranter Spamschutz: Honigtopf-Feld + Mindestabstand von 8 Sekunden pro IP
const SPAM_HONIGTOPF = "homepage";
const MINDEST_ABSTAND_MS = 8 * 1000;
const letzterWunsch = new Map(); // IP → Zeitpunkt des letzten gespeicherten Wunsches

setInterval(function () {
  const jetzt = Date.now();
  for (const [ip, zeit] of letzterWunsch) {
    if (jetzt - zeit > MINDEST_ABSTAND_MS) letzterWunsch.delete(ip);
  }
}, 60 * 1000).unref();

// Passwort für den geheimen Verwaltungsbereich /admin (steht in der .env)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin123";
const ADMIN_SESSION_DAUER = 2 * 60 * 60 * 1000; // 2 Stunden
const ADMIN_MAX_VERSUCHE = 5;
const ADMIN_SPERRZEIT = 5 * 60 * 1000; // 5 Minuten nach zu vielen Fehlversuchen

// Die "Posits" sind die gelben Blätter, auf die die Wünsche geschrieben werden.
// textBereich beschreibt, wo auf dem Blatt freie Fläche für den Text ist.
// schriftFaktor legt die Schriftgröße fest (in % der Blattbreite).
const POSIT_BILDER = [
  {
    url: "/img/posit/1.png",
    breite: 200,
    hoehe: 223,
    textBereich: { links: "11%", rechts: "9%", oben: "25%", unten: "15%" },
    schriftFaktor: 8,
    fotoBreite: 56,
    fotoTextOben: 0,
  },
  {
    url: "/img/posit/2.png",
    breite: 282,
    hoehe: 300,
    textBereich: { links: "13%", rechts: "9%", oben: "17%", unten: "20%" },
    schriftFaktor: 7.8,
    fotoBreite: 56,
    fotoTextOben: 11,
  },
  {
    url: "/img/posit/3.png",
    breite: 500,
    hoehe: 354,
    textBereich: { links: "24%", rechts: "23%", oben: "17%", unten: "13%" },
    schriftFaktor: 5.3,
    fotoBreite: 41,
    fotoTextOben: 16,
  },
];

// --- EJS als Template-Engine einrichten ---
// Seiten liegen in ./views, die EJS-Resources (Partials) in ./views/resources
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Statische Dateien (Bilder, CSS, JS) aus ./public
app.use(express.static(path.join(__dirname, "public")));

// Hochgeladene Wunschbilder aus ./storage/bilder
app.use(
  "/bilder",
  express.static(BILD_ORDNER, {
    maxAge: "30d",
    immutable: true,
    index: false,
    dotfiles: "deny",
  }),
);

// Formulardaten entgegennehmen (POST /wuensche)
// Der Grenzwert ist großzügig, weil das Bild als Text mitgeschickt wird
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

// --- Datenzugriff auf storage/db.json ---
function readEintraege() {
  try {
    const rohdaten = fs.readFileSync(DB_FILE, "utf8").trim();
    if (!rohdaten) return [];

    const daten = JSON.parse(rohdaten);
    if (Array.isArray(daten)) return daten;
    if (Array.isArray(daten.eintraege)) return daten.eintraege;
    return [];
  } catch (fehler) {
    console.error("db.json konnte nicht gelesen werden:", fehler.message);
    return [];
  }
}

function writeEintraege(eintraege) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(eintraege, null, 2), "utf8");
}

function sortiereNachDatum(eintraege) {
  return eintraege
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function ladeServerKonfiguration() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (fehler) {
    if (fehler.code !== "ENOENT") {
      console.error("Server-Konfiguration konnte nicht gelesen werden:", fehler.message);
    }
    return {};
  }
}

function ladeDiscordKonfiguration() {
  const konfiguration = ladeServerKonfiguration();
  const gespeicherteNachricht =
    typeof konfiguration.discordNachricht === "string"
      ? konfiguration.discordNachricht
      : DISCORD_NACHRICHT_DEFAULT;
  const hatGespeichertenTitel =
    typeof konfiguration.discordWebhookTitel === "string" &&
    konfiguration.discordWebhookTitel.trim();
  return {
    discordWebhookUrl:
      typeof konfiguration.discordWebhookUrl === "string"
        ? konfiguration.discordWebhookUrl.trim()
        : "",
    discordWebhookName:
      typeof konfiguration.discordWebhookName === "string" &&
      konfiguration.discordWebhookName.trim()
        ? konfiguration.discordWebhookName.trim()
        : DISCORD_WEBHOOK_NAME_DEFAULT,
    discordWebhookTitel: hatGespeichertenTitel
      ? konfiguration.discordWebhookTitel.trim()
      : DISCORD_TITEL_DEFAULT,
    discordNachricht:
      !hatGespeichertenTitel && gespeicherteNachricht === DISCORD_NACHRICHT_LEGACY_DEFAULT
        ? DISCORD_NACHRICHT_DEFAULT
        : gespeicherteNachricht,
    discordWebhookFarbe:
      typeof konfiguration.discordWebhookFarbe === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(konfiguration.discordWebhookFarbe.trim())
        ? konfiguration.discordWebhookFarbe.trim().toLowerCase()
        : DISCORD_FARBE_DEFAULT,
  };
}

function speichereDiscordKonfiguration(neueKonfiguration) {
  const konfiguration = ladeServerKonfiguration();
  konfiguration.discordWebhookUrl = neueKonfiguration.discordWebhookUrl;
  konfiguration.discordWebhookName = neueKonfiguration.discordWebhookName;
  konfiguration.discordWebhookTitel = neueKonfiguration.discordWebhookTitel;
  konfiguration.discordNachricht = neueKonfiguration.discordNachricht;
  konfiguration.discordWebhookFarbe = neueKonfiguration.discordWebhookFarbe;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(konfiguration, null, 2),
    "utf8",
  );
}

function formatiereDiscordNachricht(vorlage, wunsch) {
  if (vorlage.includes("{wunsch}")) {
    return vorlage.split("{wunsch}").join(wunsch);
  }
  return vorlage ? vorlage + "\n" + wunsch : wunsch;
}

function istGueltigeDiscordWebhookUrl(wert) {
  try {
    const webhookUrl = new URL(wert);
    const erlaubteHosts = new Set(["discord.com", "discordapp.com"]);
    return (
      webhookUrl.protocol === "https:" &&
      erlaubteHosts.has(webhookUrl.hostname.toLowerCase()) &&
      /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(webhookUrl.pathname)
    );
  } catch (fehler) {
    return false;
  }
}

discordKonfiguration = ladeDiscordKonfiguration();

// Optional: Den serverseitig konfigurierten Discord-Kanal benachrichtigen.
// Fehler beim Webhook duerfen einen bereits gespeicherten Wunsch nicht betreffen.
async function benachrichtigeDiscord(eintrag) {
  if (!discordKonfiguration.discordWebhookUrl) return;

  try {
    const webhookUrl = new URL(discordKonfiguration.discordWebhookUrl);
    webhookUrl.searchParams.set("wait", "true");

    const payload = {
      username: discordKonfiguration.discordWebhookName,
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: discordKonfiguration.discordWebhookTitel,
          description: formatiereDiscordNachricht(
            discordKonfiguration.discordNachricht,
            eintrag.text,
          ),
          color: parseInt(discordKonfiguration.discordWebhookFarbe.slice(1), 16),
        },
      ],
    };

    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    };

    if (eintrag.bild) {
      const dateiname = path.basename(eintrag.bild);
      const bildPfad = path.join(BILD_ORDNER, dateiname);
      const endung = path.extname(dateiname).slice(1).toLowerCase();
      const mimeType =
        Object.keys(BILD_ENDUNGEN).find(
          (typ) => BILD_ENDUNGEN[typ] === endung,
        ) || "application/octet-stream";
      const formular = new FormData();

      payload.embeds[0].image = { url: "attachment://" + dateiname };
      formular.append("payload_json", JSON.stringify(payload));
      formular.append(
        "files[0]",
        new Blob([fs.readFileSync(bildPfad)], { type: mimeType }),
        dateiname,
      );

      delete request.headers;
      request.body = formular;
    }

    const antwort = await fetch(webhookUrl, {
      ...request,
    });

    if (!antwort.ok) {
      console.error(
        "Discord-Webhook antwortete mit Status " + antwort.status + ".",
      );
    }
  } catch (fehler) {
    console.error("Discord-Webhook konnte nicht gesendet werden:", fehler.message);
  }
}

// Die Pinnwand ist eine große Karte. Positionen werden in Prozent (0-100) gespeichert.
function zahl(wert, min, max, ersatz) {
  const n = Number(wert);
  if (!Number.isFinite(n)) return ersatz;
  return Math.min(max, Math.max(min, n));
}

// Beim Erstellen bekommt jeder Wunsch einmalig eine zufällige Stelle auf der Karte,
// mit mindestens etwas Abstand zu den bereits hängenden Wünschen
function zufallsPosition(bestehende) {
  const MINDEST_ABSTAND = 15; // Prozent der Karte, gemessen von Wunschmitte zu Wunschmitte
  let besterKandidat = null;
  let besterAbstand = -1;

  for (let versuch = 0; versuch < 40; versuch++) {
    const kandidat = {
      x: Math.round(6 + Math.random() * 88),
      y: Math.round(8 + Math.random() * 84),
    };

    let kleinsterAbstand = Infinity;
    for (const anderer of bestehende) {
      const abstand = Math.hypot(
        kandidat.x - Number(anderer.x),
        kandidat.y - Number(anderer.y),
      );
      if (abstand < kleinsterAbstand) kleinsterAbstand = abstand;
    }

    if (kleinsterAbstand >= MINDEST_ABSTAND) return kandidat;
    if (kleinsterAbstand > besterAbstand) {
      besterAbstand = kleinsterAbstand;
      besterKandidat = kandidat;
    }
  }

  // Die Wand ist voll – die am weitesten entfernte Stelle nehmen
  return besterKandidat || { x: 50, y: 50 };
}

// Deterministische Ersatzposition für alte Einträge ohne gespeicherte Koordinaten
function ersatzPosition(index, gesamt) {
  const spalten = Math.max(
    2,
    Math.min(7, Math.ceil(Math.sqrt(Math.max(gesamt, 1) * 1.8))),
  );
  const zeilen = Math.max(1, Math.ceil(gesamt / spalten));
  const spalte = index % spalten;
  const zeile = Math.floor(index / spalten);
  const streuungX = (((index * 37) % 13) - 6) * 0.7;
  const streuungY = (((index * 53) % 11) - 5) * 0.9;

  return {
    x: zahl(7 + ((spalte + 0.5) / spalten) * 86 + streuungX, 5, 95, 50),
    y: zahl(10 + ((zeile + 0.5) / zeilen) * 80 + streuungY, 6, 94, 50),
  };
}

// Einträge laden; Einträge ohne x/y bekommen einmalig eine feste Position,
// und Wünsche, die auf derselben Stelle hängen, werden einmalig entzerrt
function ladeEintraege() {
  const eintraege = readEintraege();
  let geaendert = false;

  eintraege.forEach(function (eintrag, index) {
    if (
      !Number.isFinite(Number(eintrag.x)) ||
      !Number.isFinite(Number(eintrag.y))
    ) {
      const position = ersatzPosition(index, eintraege.length);
      eintrag.x = position.x;
      eintrag.y = position.y;
      geaendert = true;
    }
  });

  const bereitsGesetzt = [];
  eintraege.forEach(function (eintrag) {
    const gestapelt = bereitsGesetzt.some(function (anderer) {
      return (
        Math.hypot(
          Number(eintrag.x) - Number(anderer.x),
          Number(eintrag.y) - Number(anderer.y),
        ) < 3
      );
    });

    if (gestapelt) {
      const position = zufallsPosition(bereitsGesetzt);
      eintrag.x = position.x;
      eintrag.y = position.y;
      geaendert = true;
    }

    bereitsGesetzt.push(eintrag);
  });

  if (geaendert) {
    try {
      writeEintraege(eintraege);
    } catch (fehler) {
      console.error(
        "Positionen konnten nicht gespeichert werden:",
        fehler.message,
      );
    }
  }

  return eintraege;
}

// Einem Eintrag die Daten des passenden Posits mitgeben (Bild, Seitenverhältnis, Textfläche)
function mitPositDaten(eintrag) {
  const posit =
    POSIT_BILDER.find((bild) => bild.url === eintrag.image) || POSIT_BILDER[0];

  // Nur Bilder aus unserem eigenen Ordner zulassen
  const foto =
    typeof eintrag.bild === "string" && eintrag.bild.indexOf("/bilder/") === 0
      ? eintrag.bild
      : null;

  // Mit Bild rutscht der Text ein Stück nach unten, damit das Foto
  // nicht über die Zeilen ragt
  const textBereich = Object.assign({}, posit.textBereich);
  if (foto) {
    const oben = parseFloat(posit.textBereich.oben) || 0;
    textBereich.oben = Math.min(45, oben + (posit.fotoTextOben || 0)) + "%";
  }

  return Object.assign({}, eintrag, {
    image: posit.url,
    bildIndex: POSIT_BILDER.indexOf(posit) + 1,
    aspect: Number((posit.breite / posit.hoehe).toFixed(4)),
    textBereich: textBereich,
    schriftFaktor: posit.schriftFaktor,
    fotoBreite: foto ? posit.fotoBreite : 0,
    bild: foto,
    x: zahl(eintrag.x, 0, 100, 50),
    y: zahl(eintrag.y, 0, 100, 50),
  });
}

// --- Bilder an Wünsche ---

// Prüft, ob die Bytes wirklich zum angegebenen Bildtyp passen
function bildPasst(puffer, endung) {
  if (endung === "jpg") {
    return puffer.length > 3 && puffer[0] === 0xff && puffer[1] === 0xd8 && puffer[2] === 0xff;
  }
  if (endung === "png") {
    return puffer.length > 8 && puffer.toString("hex", 0, 4) === "89504e47";
  }
  if (endung === "webp") {
    return (
      puffer.length > 12 &&
      puffer.toString("ascii", 0, 4) === "RIFF" &&
      puffer.toString("ascii", 8, 12) === "WEBP"
    );
  }
  return false;
}

// Legt ein angehängtes Bild in storage/bilder ab und gibt die öffentliche
// URL zurück. Bei unbrauchbaren Daten kommt null zurück.
function speichereBild(datenUrl) {
  const treffer = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
    String(datenUrl || "").trim(),
  );
  if (!treffer) return null;

  const endung = BILD_ENDUNGEN[treffer[1]];
  if (!endung) return null;

  const puffer = Buffer.from(treffer[2], "base64");
  if (!puffer.length || puffer.length > MAX_BILD_BYTES) return null;
  if (!bildPasst(puffer, endung)) return null;

  // Dateinamen selbst erzeugen – der Name des Uploads wird nie übernommen
  const name = crypto.randomUUID() + "." + endung;

  try {
    fs.mkdirSync(BILD_ORDNER, { recursive: true });
    fs.writeFileSync(path.join(BILD_ORDNER, name), puffer);
  } catch (fehler) {
    console.error("Bild konnte nicht gespeichert werden:", fehler.message);
    return null;
  }

  return "/bilder/" + name;
}

// Entfernt ein Bild wieder von der Platte
function loescheBild(url) {
  if (typeof url !== "string" || url.indexOf("/bilder/") !== 0) return;
  const name = path.basename(url);
  try {
    fs.unlinkSync(path.join(BILD_ORDNER, name));
  } catch (fehler) {
    // Datei schon weg – kein Problem
  }
}

// --- Routen ---
app.get("/", (req, res) => {
  res.render("index", {
    eintraege: sortiereNachDatum(ladeEintraege()).map(mitPositDaten),
    fehler: req.query.fehler || null,
    textVorbelegt: req.query.text || null,
    neuId: req.query.neu || null,
    titel: "Genesungsseite für Manfred",
  });
});

// Neuen Wunsch aufschreiben und an die Pinnwand hängen
app.post("/wuensche", (req, res) => {
  // Seiten, die per JavaScript absenden (kein Neuladen), bekommen JSON zurück
  const ajax = req.get("X-Requested-With") === "XMLHttpRequest";

  function weiterleiten(fehlerCode, daten) {
    let ziel = "/?fehler=" + encodeURIComponent(fehlerCode);
    if (daten.text) ziel += "&text=" + encodeURIComponent(daten.text);
    return res.redirect(ziel);
  }

  function fehlerAntwort(status, code, daten) {
    daten = daten || {};
    if (ajax) {
      return res
        .status(status)
        .json(Object.assign({ ok: false, fehler: code }, daten));
    }
    return weiterleiten(code, daten);
  }

  // Honigtopf gefüllt → vermutlich Bot: tun, als wäre alles in Ordnung, nichts speichern
  if ((req.body[SPAM_HONIGTOPF] || "").toString().trim() !== "") {
    if (ajax) return res.json({ ok: true, eintrag: null });
    return res.redirect("/");
  }

  const text = (req.body.text || "").toString().trim();

  if (!text) {
    return fehlerAntwort(422, "leer");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return fehlerAntwort(422, "zu-lang", { text });
  }

  // Mindestabstand pro IP - schützt vor massenhaften Abgaben, stört aber niemanden
  const jetzt = Date.now();
  const letztes = letzterWunsch.get(req.ip) || 0;
  if (jetzt - letztes < MINDEST_ABSTAND_MS) {
    return fehlerAntwort(429, "zu-schnell", { text });
  }

  const eintraege = ladeEintraege();

  // Optional hängt ein Bild am Wunsch
  const bildDaten = (req.body.bild || "").toString();
  let bildUrl = null;

  if (bildDaten) {
    bildUrl = speichereBild(bildDaten);
    if (!bildUrl) {
      return fehlerAntwort(422, "bild-ungueltig", { text });
    }
  }

  // Jeder neue Wunsch landet auf dem nächsten freien Posit
  const posit = POSIT_BILDER[eintraege.length % POSIT_BILDER.length];
  const position = zufallsPosition(eintraege);
  const eintrag = {
    id: crypto.randomUUID(),
    text: text,
    image: posit.url,
    createdAt: new Date().toISOString(),
    x: position.x,
    y: position.y,
  };

  if (bildUrl) eintrag.bild = bildUrl;

  eintraege.push(eintrag);

  try {
    writeEintraege(eintraege);
    letzterWunsch.set(req.ip, jetzt);
  } catch (fehler) {
    console.error("db.json konnte nicht gespeichert werden:", fehler.message);
    loescheBild(bildUrl);
    return fehlerAntwort(500, "speicher", { text });
  }

  void benachrichtigeDiscord(eintrag);

  if (ajax) {
    return res.json({ ok: true, eintrag: mitPositDaten(eintrag) });
  }

  // Direkt zur neuen Kartenstelle springen
  res.redirect("/?neu=" + encodeURIComponent(eintrag.id));
});

// JSON-Schnittstelle, falls die Pinnwand später live aktualisiert werden soll
app.get("/api/wuensche", (req, res) => {
  res.json(sortiereNachDatum(ladeEintraege()).map(mitPositDaten));
});

// Der Verwaltungsbereich soll nicht in Suchmaschinen landen
app.get("/robots.txt", (req, res) => {
  res
    .type("text/plain")
    .send("User-agent: *\nDisallow: /admin\nDisallow: /api\n");
});

// --- Geheimer Verwaltungsbereich /admin ---
// Wird bewusst nicht in der Navigation verlinkt.
const adminSessions = new Map();
const adminFehlversuche = new Map();

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((teil) => {
    const trenner = teil.indexOf("=");
    if (trenner === -1) return;
    cookies[teil.slice(0, trenner).trim()] = decodeURIComponent(
      teil.slice(trenner + 1).trim(),
    );
  });
  return cookies;
}

function adminAngemeldet(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;

  const sitzung = adminSessions.get(token);
  if (!sitzung) return false;

  if (sitzung.laufzeitBis < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function passwortPasst(eingabe) {
  const hashEingabe = crypto
    .createHash("sha256")
    .update(String(eingabe))
    .digest();
  const hashPasswort = crypto
    .createHash("sha256")
    .update(String(ADMIN_PASSWORD))
    .digest();
  return crypto.timingSafeEqual(hashEingabe, hashPasswort);
}

function adminGesperrt(ip) {
  const eintrag = adminFehlversuche.get(ip);
  if (!eintrag) return false;
  if (eintrag.bis < Date.now()) {
    adminFehlversuche.delete(ip);
    return false;
  }
  return true;
}

function fehlversuchNotieren(ip) {
  const eintrag = adminFehlversuche.get(ip) || { anzahl: 0, bis: 0 };
  eintrag.anzahl += 1;

  if (eintrag.anzahl >= ADMIN_MAX_VERSUCHE) {
    eintrag.bis = Date.now() + ADMIN_SPERRZEIT;
    eintrag.anzahl = 0;
  }

  adminFehlversuche.set(ip, eintrag);
}

// Anmeldung
app.post("/admin/login", (req, res) => {
  const ip = req.ip;

  if (adminGesperrt(ip)) {
    return res.redirect("/admin?fehler=gesperrt");
  }

  if (!passwortPasst(req.body.passwort)) {
    fehlversuchNotieren(ip);
    return res.redirect("/admin?fehler=falsch");
  }

  adminFehlversuche.delete(ip);

  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { laufzeitBis: Date.now() + ADMIN_SESSION_DAUER });

  res.cookie("admin_session", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: ADMIN_SESSION_DAUER,
    path: "/",
  });

  res.redirect("/admin");
});

// Abmeldung
app.post("/admin/logout", (req, res) => {
  const token = parseCookies(req).admin_session;
  if (token) adminSessions.delete(token);

  res.clearCookie("admin_session", { path: "/" });
  res.redirect("/admin");
});

// Discord-Webhook im geschuetzten Verwaltungsbereich konfigurieren
app.post("/admin/webhook", (req, res) => {
  if (!adminAngemeldet(req)) {
    return res.redirect("/admin");
  }

  if (req.body.aktion === "entfernen") {
    try {
      const neueKonfiguration = {
        ...discordKonfiguration,
        discordWebhookUrl: "",
      };
      speichereDiscordKonfiguration(neueKonfiguration);
      discordKonfiguration = neueKonfiguration;
      return res.redirect("/admin?webhook=entfernt");
    } catch (fehler) {
      console.error("Discord-Webhook konnte nicht entfernt werden:", fehler.message);
      return res.redirect("/admin?webhook=speicherfehler");
    }
  }

  const eingegebeneWebhookUrl = (req.body.webhookUrl || "").toString().trim();
  const neueWebhookUrl =
    eingegebeneWebhookUrl || discordKonfiguration.discordWebhookUrl;
  const neuerWebhookName = (req.body.webhookName || "").toString().trim();
  const neuerWebhookTitel = (req.body.webhookTitel || "").toString().trim();
  const neueNachricht = (req.body.webhookNachricht || "").toString();
  const neueWebhookFarbe = (req.body.webhookFarbe || "").toString().trim().toLowerCase();

  if (!neueWebhookUrl || !istGueltigeDiscordWebhookUrl(neueWebhookUrl)) {
    return res.redirect("/admin?webhook=ungueltig");
  }
  if (!neuerWebhookName || neuerWebhookName.length > DISCORD_WEBHOOK_NAME_MAX) {
    return res.redirect("/admin?webhook=name-ungueltig");
  }
  if (!neuerWebhookTitel || neuerWebhookTitel.length > DISCORD_TITEL_MAX) {
    return res.redirect("/admin?webhook=titel-ungueltig");
  }
  if (neueNachricht.length > DISCORD_NACHRICHT_MAX) {
    return res.redirect("/admin?webhook=nachricht-ungueltig");
  }
  if (!/^#[0-9a-f]{6}$/.test(neueWebhookFarbe)) {
    return res.redirect("/admin?webhook=farbe-ungueltig");
  }

  try {
    const neueKonfiguration = {
      discordWebhookUrl: neueWebhookUrl,
      discordWebhookName: neuerWebhookName,
      discordWebhookTitel: neuerWebhookTitel,
      discordNachricht: neueNachricht,
      discordWebhookFarbe: neueWebhookFarbe,
    };
    speichereDiscordKonfiguration(neueKonfiguration);
    discordKonfiguration = neueKonfiguration;
    return res.redirect("/admin?webhook=gespeichert");
  } catch (fehler) {
    console.error("Discord-Webhook konnte nicht gespeichert werden:", fehler.message);
    return res.redirect("/admin?webhook=speicherfehler");
  }
});

// Übersicht mit allen Wünschen (nur für Angemeldete)
app.get("/admin", (req, res) => {
  const angemeldet = adminAngemeldet(req);

  res.render("admin", {
    titel: "Verwaltung",
    angemeldet: angemeldet,
    loginFehler: req.query.fehler || null,
    webhookStatus: req.query.webhook || null,
    webhookKonfiguriert: Boolean(discordKonfiguration.discordWebhookUrl),
    webhookName: discordKonfiguration.discordWebhookName,
    webhookTitel: discordKonfiguration.discordWebhookTitel,
    webhookNachricht: discordKonfiguration.discordNachricht,
    webhookFarbe: discordKonfiguration.discordWebhookFarbe,
    eintraege: angemeldet
      ? sortiereNachDatum(ladeEintraege()).map(mitPositDaten)
      : [],
  });
});

// Wunsch im Verwaltungsbereich löschen
app.post("/admin/eintraege/:id/loeschen", (req, res) => {
  if (!adminAngemeldet(req)) {
    return res.redirect("/admin");
  }

  const zuLoeschen = readEintraege().filter(
    (eintrag) => eintrag.id === req.params.id,
  );
  const eintraege = readEintraege().filter(
    (eintrag) => eintrag.id !== req.params.id,
  );

  try {
    writeEintraege(eintraege);
  } catch (fehler) {
    console.error("db.json konnte nicht gespeichert werden:", fehler.message);
  }

  // Das angehängte Bild wird nicht mehr gebraucht
  zuLoeschen.forEach((eintrag) => loescheBild(eintrag.bild));

  res.redirect("/admin");
});

// Seite nicht gefunden
app.use((req, res) => {
  res.status(404).render("404", {
    titel: "Seite nicht gefunden",
    fehler: null,
  });
});

app.listen(PORT, () => {
  console.log(`Genesungsseite läuft auf http://localhost:${PORT}`);
});
