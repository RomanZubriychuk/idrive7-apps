'use strict';
/**
 * dpf.js - the particulate filter of a B47 / B57 diesel: what to read, and what it means.
 * No kit or head-unit code in here, so `node test_dpf.js` runs it on any computer.
 *
 *   DIDS      the engine unit's (DDE, address 0x12) identifiers, read with UDS 0x22. They are the ones the kit's
 *             Service app reads on its Engine page (apps/service/main.js, DIESEL), so a car that shows values there
 *             shows them here.
 *   Monitor   fed one sample per read; it decides when a regeneration starts, finishes or was cut short, keeps a
 *             log of them in a small JSON file and says about how far the next one is.
 *   demoSample(t)   a made-up drive for the emulator and the demo setting: soot builds up, a regeneration burns it.
 */
const fs = require('fs');

// candidate lists as kit/runtime/dids.js wants them: value = raw * factor + offset, outside min..max = no value
const DIDS = {
    soot: [{ did: '44BE', bytes: 2, factor: 0.01525902, min: 0, max: 200 }],                     // soot in the filter, g
    ash: [{ did: '44BD', bytes: 2, factor: 0.01525902, min: 0, max: 1000 }],                     // oil ash in it, g
    temp: [{ did: '4502', bytes: 2, factor: 0.03128099, offset: -50, min: -40, max: 1000 }],     // before the filter, deg C
    dp: [{ did: '44ED', bytes: 2, factor: 0.04577707, offset: -1000, min: -200, max: 1000 }],    // pressure across it, hPa
    regens: [{ did: '44B8', bytes: 2, min: 0, max: 65000 }],                                     // successful regenerations
    sinceKm: [{ did: '44BF', bytes: 4, factor: 0.001, min: 0, max: 100000 }],                    // distance since the last
    sinceH: [{ did: '44B7', bytes: 4, factor: 1 / 3600, min: 0, max: 10000 }],                   // engine time since it
    sinceL: [{ did: '44BC', bytes: 2, factor: 0.01, min: 0, max: 600 }],                         // fuel since it, l
    avgKm: [{ did: '44C7', bytes: 2, min: 0, max: 65000 }],                                      // average distance between
};
const ALL = Object.keys(DIDS);
const FAST = ['soot', 'temp', 'dp', 'regens'];            // what changes during a regeneration
// SGBD indexes (22 F1 50) of the B47 / B57 engine units these identifiers are for
const DDE_INDEXES = ['0F1F70', '0F1F80', '0F1F90', '0F1FA0', '0F1FE8', '0F1FF0', '0F1FF4', '0F1FF8', '0F2670', '0F2674', '0F2678', '0F267C'];

const isNum = (x) => typeof x === 'number' && isFinite(x);
const HOT_READS = 2;          // reads in a row above the limit before it counts as a regeneration
const COOL_READS = 3;         // reads in a row well below it before it counts as over
const COOL_BY = 100;          // deg C under the limit = cooled down
const JOIN_MS = 15 * 60000;   // the unit's counter moving this soon after one we saw = the same regeneration
const KEEP = 60;              // log entries kept

class Monitor {
    /** file: where the log lives (null = memory only, for the demo); log: { info, warn }. */
    constructor(opts) {
        opts = opts || {};
        this.file = opts.file || null;
        this.log = opts.log || { info() {}, warn() {} };
        this.regenTemp = opts.regenTemp || 500;
        this.last = {};               // the newest value of everything, with .t of the last read
        this.st = { count: null, sinceKm: null, running: null, interrupted: false, history: [] };
        this.hot = 0; this.cool = 0;
        this._load();
    }

    _load() {
        if (!this.file) return;
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (j && Array.isArray(j.history)) this.st = Object.assign(this.st, j);
        } catch (e) { /* first run, or an unreadable file: start empty */ }
        // the head unit went off in the middle of one: it never finished while we watched
        if (this.st.running) {
            this._entry({ at: this.st.running.at, kind: 'interrupted', sootBefore: this.st.running.sootStart, km: this.st.running.km });
            this.st.running = null; this.st.interrupted = true;
            this._save();
        }
    }

    _save() {
        if (!this.file) return;
        try {
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.st));
            fs.renameSync(tmp, this.file);
        } catch (e) { this.log.warn('dpf log not saved: ' + e); }
    }

    _entry(e) {
        this.st.history.push(e);
        while (this.st.history.length > KEEP) this.st.history.shift();
        return e;
    }

    get running() { return this.st.running; }
    get interrupted() { return !!this.st.interrupted && !this.st.running; }
    get history() { return this.st.history; }

    /**
     * One read: s = { t, soot, ash, temp, dp, regens, sinceKm, sinceH, sinceL, avgKm } (null / missing = not read).
     * Returns what happened: [] or some of 'start', 'done', 'interrupted'.
     */
    update(s) {
        const ev = [], t = isNum(s.t) ? s.t : Date.now(), prev = this.last;
        const next = Object.assign({}, prev, { t });
        ALL.forEach((k) => { if (isNum(s[k])) next[k] = s[k]; });
        this.last = next;
        let dirty = false;

        // 1. the unit says one finished: its counter went up, or (without a counter) the distance since fell back
        let finished = false;
        if (isNum(s.regens)) {
            if (isNum(this.st.count) && s.regens > this.st.count) finished = true;
            if (this.st.count !== s.regens) { this.st.count = s.regens; dirty = true; }
        } else if (!isNum(this.st.count) && isNum(s.sinceKm) && isNum(this.st.sinceKm)
            && this.st.sinceKm > 20 && s.sinceKm < this.st.sinceKm * 0.5) finished = true;
        const kmBefore = this.st.sinceKm;       // the distance the filter did before this one
        if (isNum(s.sinceKm)) {
            if (!isNum(this.st.sinceKm) || Math.abs(this.st.sinceKm - s.sinceKm) >= 1) dirty = true;
            this.st.sinceKm = s.sinceKm;
        }

        // 2. hot before the filter = a regeneration is burning
        if (isNum(s.temp)) {
            if (s.temp >= this.regenTemp) { this.hot++; this.cool = 0; }
            else if (s.temp < this.regenTemp - COOL_BY) { this.cool++; this.hot = 0; }
            else this.hot = 0;
        }
        const run = this.st.running;
        if (!run && !finished && this.hot >= HOT_READS) {
            this.st.running = { at: t, sootStart: isNum(prev.soot) ? Math.max(prev.soot, isNum(s.soot) ? s.soot : 0) : isNum(s.soot) ? s.soot : null,
                km: isNum(kmBefore) ? kmBefore : null };
            this.st.interrupted = false;
            this.cool = 0; dirty = true; ev.push('start');
        } else if (run && finished) {
            this._close('done', t, next, this.st.count); ev.push('done');
            dirty = true;
        } else if (run && this.cool >= COOL_READS) {
            // cooled down and the counter hasn't said so (yet): finished if most of the soot went, else cut short
            const burnt = isNum(run.sootStart) && isNum(next.soot) && next.soot <= Math.max(3, run.sootStart * 0.6);
            const kind = burnt ? 'done' : 'interrupted';
            this._close(kind, t, next, null); ev.push(kind);
            dirty = true;
        } else if (!run && finished) {
            // the counter moved without us seeing it burn: the one we just closed, or one that ran unwatched
            const h = this.st.history, lastE = h[h.length - 1];
            if (lastE && !isNum(lastE.n) && t - (lastE.end || lastE.at) < JOIN_MS) {
                lastE.n = this.st.count; lastE.kind = 'done';
            } else {
                this._entry({ at: t, kind: 'done', n: isNum(this.st.count) ? this.st.count : null, km: isNum(kmBefore) ? Math.round(kmBefore) : null, unseen: true });
                ev.push('done');
            }
            this.st.interrupted = false; this.hot = 0;
            dirty = true;
        }
        if (dirty) this._save();
        return ev;
    }

    _close(kind, t, v, n) {
        const run = this.st.running;
        this._entry({
            at: run.at, end: t, kind, n: isNum(n) ? n : null,
            min: Math.max(1, Math.round((t - run.at) / 60000)),
            sootBefore: isNum(run.sootStart) ? Math.round(run.sootStart * 10) / 10 : null,
            sootAfter: isNum(v.soot) ? Math.round(v.soot * 10) / 10 : null,
            km: isNum(run.km) ? Math.round(run.km) : null,
        });
        this.st.running = null; this.hot = 0; this.cool = 0;
        this.st.interrupted = kind === 'interrupted';
    }

    /** The engine has been off for good while one was burning. Returns ['interrupted'] or []. */
    engineOff(t) {
        if (!this.st.running) return [];
        this._close('interrupted', isNum(t) ? t : Date.now(), this.last, null);
        this._save();
        return ['interrupted'];
    }

    /** About how far the next regeneration is: { km, avg, from } or null. from: 'unit' (its own average) | 'log'. */
    forecast() {
        const since = this.last.sinceKm;
        if (!isNum(since)) return null;
        let avg = isNum(this.last.avgKm) && this.last.avgKm > 0 ? this.last.avgKm : null, from = 'unit';
        if (!avg) {
            const kms = this.st.history.filter((e) => e.kind === 'done' && isNum(e.km) && e.km > 0).map((e) => e.km);
            if (kms.length >= 2) { avg = kms.reduce((a, b) => a + b, 0) / kms.length; from = 'log'; }
        }
        if (!avg) return null;
        return { km: Math.max(0, Math.round(avg - since)), avg: Math.round(avg), from };
    }

    stats() {
        const h = this.st.history, done = h.filter((e) => e.kind === 'done'), cut = h.filter((e) => e.kind === 'interrupted');
        const mins = done.filter((e) => isNum(e.min)).map((e) => e.min), kms = done.filter((e) => isNum(e.km) && e.km > 0).map((e) => e.km);
        const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
        return { seen: h.length, done: done.length, interrupted: cut.length, avgMin: mean(mins), avgKm: mean(kms), last: h[h.length - 1] || null };
    }
}

/**
 * The demo drive, 90 s long and then again: 60 s of soot building up, 25 s of regeneration, 5 s cooling.
 * t in ms; returns a full sample.
 */
function demoSample(t) {
    const CYC = 90, s = (t / 1000) % CYC, n = Math.floor(t / 1000 / CYC), burning = s >= 60 && s < 85;
    const soot = s < 60 ? 9 + (s / 60) * 15 : s < 85 ? 24 - ((s - 60) / 25) * 20 : 4 + ((s - 85) / 5) * 5;
    const temp = s < 58 ? 280 + 25 * Math.sin(s / 4) : s < 60 ? 280 + (s - 58) * 160 : burning ? 610 + 15 * Math.sin(s) : 610 - (s - 85) * 62;
    const done = s >= 85;
    return {
        t, soot, ash: 38.4, temp, dp: 8 + soot * 1.3,
        regens: 137 + (n % 100) + (done ? 1 : 0),          // n counts from 1970: keep the demo total small
        sinceKm: done ? (s - 85) * 0.4 : 312 + s * 0.4,
        sinceH: done ? 0.01 : 6.2 + s / 600,
        sinceL: done ? 0.1 : 21.5 + s * 0.02,
        avgKm: 486,
    };
}

module.exports = { DIDS, ALL, FAST, DDE_INDEXES, Monitor, demoSample, isNum };
