'use strict';
/**
 * drives.js - every read of a drive into a CSV file, to calibrate the thresholds against a real car.
 *
 *   const rec = new Recorder({ dir, log });
 *   rec.sample({ t, rpm, speed, soot, ..., regen: 1, event: 'start' })   one line; a missing value is left empty
 *   rec.flush()                                                           write what is buffered
 *   rec.count()                                                           drives on disk
 *
 * One file a drive: drive-YYYYMMDD-HHMMSS.csv (local time of its first read). A drive ends when no sample came for
 * gapMs (10 min: the engine was off, or the car slept). Lines are buffered and written every FLUSH_LINES lines,
 * FLUSH_MS, or at once with an event, so a head unit that loses power loses at most a few seconds. A file stops
 * growing at maxBytes; only the newest `keep` drives stay.
 *
 * Node 8 (the head unit's): no fs.mkdirSync recursive, no optional chaining.
 */
const fs = require('fs');
const path = require('path');

const COLUMNS = ['time', 'ms', 'rpm', 'speed', 'soot', 'ash', 'temp', 'dp', 'regens', 'sinceKm', 'sinceH', 'sinceL', 'avgKm', 'regen', 'event'];
const DECIMALS = { rpm: 0, speed: 1, soot: 2, ash: 2, temp: 1, dp: 1, regens: 0, sinceKm: 2, sinceH: 3, sinceL: 2, avgKm: 0 };
const FLUSH_LINES = 12, FLUSH_MS = 60000;
const NAME = /^drive-\d{8}-\d{6}\.csv$/;

const two = (n) => (n < 10 ? '0' : '') + n;
function stamp(ms) {
    const d = new Date(ms);
    return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
}
function localTime(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}
const isNum = (x) => typeof x === 'number' && isFinite(x);

class Recorder {
    constructor(opts) {
        opts = opts || {};
        this.dir = opts.dir;
        this.log = opts.log || { info() {}, warn() {} };
        this.keep = opts.keep || 30;
        this.maxBytes = opts.maxBytes || 1000000;
        this.gapMs = opts.gapMs || 10 * 60000;
        this.file = null; this.bytes = 0; this.lastT = 0; this.buf = []; this.lastFlush = 0; this.full = false;
        this.failed = false;
    }

    /** Drive files on disk, oldest first. */
    files() {
        try { return fs.readdirSync(this.dir).filter((f) => NAME.test(f)).sort(); } catch (e) { return []; }
    }
    count() { return this.files().length; }

    sample(s) {
        if (this.failed || !this.dir) return;
        const t = isNum(s.t) ? s.t : Date.now();
        if (!this.file || t - this.lastT > this.gapMs) this._open(t);
        this.lastT = t;
        const row = COLUMNS.map((k) => {
            if (k === 'time') return localTime(t);
            if (k === 'ms') return String(t);
            if (k === 'event') return s.event ? String(s.event).replace(/[,\n\r]/g, ' ') : '';
            if (k === 'regen') return s.regen ? '1' : '0';
            const v = s[k];
            return isNum(v) ? (DECIMALS[k] === 0 ? String(Math.round(v)) : v.toFixed(DECIMALS[k])) : '';
        });
        this.buf.push(row.join(','));
        if (s.event || this.buf.length >= FLUSH_LINES || t - this.lastFlush >= FLUSH_MS) this.flush(t);
    }

    flush(t) {
        if (!this.file || !this.buf.length || this.failed) return;
        const text = this.buf.join('\n') + '\n';
        this.buf = [];
        this.lastFlush = isNum(t) ? t : Date.now();
        if (this.full) return;
        if (this.bytes + text.length > this.maxBytes) {
            this.full = true;
            this.log.warn('drive log ' + path.basename(this.file) + ' reached ' + this.maxBytes + ' bytes: the rest of this drive is not recorded');
            return;
        }
        try {
            fs.appendFileSync(this.file, text);
            this.bytes += text.length;
        } catch (e) {
            this.failed = true;
            this.log.warn('drive log: ' + ((e && e.message) || e) + ' - recording stops until the app restarts');
        }
    }

    _open(t) {
        this.flush(t);
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir);
            let name = 'drive-' + stamp(t) + '.csv', n = 0;
            while (fs.existsSync(path.join(this.dir, name)) && n < 9) name = 'drive-' + stamp(t + ++n * 1000) + '.csv';
            this.file = path.join(this.dir, name);
            const head = COLUMNS.join(',') + '\n';
            fs.writeFileSync(this.file, head);
            this.bytes = head.length; this.full = false; this.lastFlush = t;
            this.log.info('drive log: ' + name);
            this._prune();
        } catch (e) {
            this.failed = true;
            this.log.warn('drive log: ' + ((e && e.message) || e) + ' - recording stops until the app restarts');
        }
    }

    _prune() {
        const all = this.files();
        all.slice(0, Math.max(0, all.length - this.keep)).forEach((f) => {
            try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* gone already */ }
        });
    }
}

module.exports = { Recorder, COLUMNS };
