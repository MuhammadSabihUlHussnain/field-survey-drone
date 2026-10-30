// Results Store (component diagram). The Unity build writes files to disk; the browser
// build keeps the same JSON in localStorage and offers it as downloads.
import { HealthMap } from './healthmap.js';

const SURVEYS_KEY = 'fsd.surveys.v1';
const LOG_KEY = 'fsd.latestLog.v1';
const MAX_SURVEYS = 12;

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

export function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('fsd.probe', '1');
    s.removeItem('fsd.probe');
    return s;
  } catch {
    return memoryStorage();
  }
}

export class ResultsStore {
  constructor(storage = safeLocalStorage()) {
    this.storage = storage;
  }

  readAll() {
    try {
      const raw = this.storage.getItem(SURVEYS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // Newest first. Each entry: { meta, healthMap: HealthMap }
  list() {
    return this.readAll()
      .map((r) => ({ meta: r.meta, healthMap: HealthMap.fromJSON(r.healthMap) }))
      .sort((a, b) => b.meta.startTime.localeCompare(a.meta.startTime));
  }

  get(surveyId) {
    return this.list().find((r) => r.meta.surveyId === surveyId) ?? null;
  }

  save(record) {
    const entry = { meta: record.meta, healthMap: record.healthMap.toJSON() };
    let all = this.readAll().filter((r) => r.meta.surveyId !== record.meta.surveyId);
    all.push(entry);
    all.sort((a, b) => a.meta.startTime.localeCompare(b.meta.startTime));
    all = all.slice(-MAX_SURVEYS);
    // Drop the oldest surveys until the browser accepts the write.
    while (all.length) {
      try {
        this.storage.setItem(SURVEYS_KEY, JSON.stringify(all));
        return true;
      } catch {
        all.shift();
      }
    }
    return false;
  }

  saveLog(meta, log) {
    try {
      this.storage.setItem(LOG_KEY, JSON.stringify({ surveyId: meta.surveyId, log }));
      return true;
    } catch {
      return false;
    }
  }

  getLog(surveyId) {
    try {
      const raw = this.storage.getItem(LOG_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && data.surveyId === surveyId ? data.log : null;
    } catch {
      return null;
    }
  }

  clear() {
    try {
      this.storage.removeItem(SURVEYS_KEY);
      this.storage.removeItem(LOG_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}
