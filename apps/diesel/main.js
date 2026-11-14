'use strict';
/**
 * Diesel - the particulate filter of a B47 / B57 diesel, with what the Service app's Engine page doesn't have:
 *
 *   - a warning across the screen while a regeneration runs ("keep driving"), and one after a regeneration that
 *     was cut short
 *   - a log of the regenerations it saw (History page): when, how long, soot before and after, distance since the
 *     one before
 *   - about how far the next one is (the engine unit's average distance between them, minus the distance since)
 *   - a home-screen widget: soot, the distance to the next one, and the warning
 *
 * Read-only: the diagnostic link is kit/runtime/readonly-diag.js, which lets nothing but UDS 0x22 through.
 * Reads only while the engine runs: every 6 s while the page or the widget shows, every 3 s during a
 * regeneration, every 30 s otherwise (setting "Keep watching with the screen closed").
 * The values and what they mean are in dpf.js; `node test_dpf.js` tests that part without a car.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { ScaledCanvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { hex } = require('./kit/diag');
const { DIDS, ALL, FAST, DDE_INDEXES, Monitor, demoSample } = require('./dpf');

const W = 1600, H = 520;
const DDE = 0x12;                      // the engine unit's diagnostic address
const GO = '#2fd27a';
const SHOWN_MS = 6000, REGEN_MS = 3000, HIDDEN_MS = 30000, FULL_MS = 30000;
const ENGINE_RPM = 400;                // above = the engine runs
const OFF_MS = 60000;                  // off this long during a regeneration = it was cut short (not a start-stop)
const NOTE_MS = 90000;                 // how long "finished" stays up
const PAGES = ['Filter', 'History'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed']);
        const real = new Monitor({ file: path.join(ctx.dataDir, 'regens.json'), log, regenTemp: settings.get('regenTemp') });
        const demo = new Monitor({ regenTemp: 500 });
        settings.onChange(() => { real.regenTemp = settings.get('regenTemp'); });

        // demo data: the setting, or (Auto) while no car answers - the emulator, a bench
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && car.data().demo);
        const mon = () => (useDemo() ? demo : real);

        /* ---------- reading the engine unit ---------- */
        let link = null, reader = null, kind = null, index = '', reading = false, lastRead = 0, lastFull = 0, error = '';
        let offSince = 0, wasOn = false, note = null;         // note: { text, color, until }

        /** The engine unit's SGBD index (22 F1 50): 'diesel' for a B47 / B57 DDE, 'other', or null without a reply. */
        async function engineKind() {
            const u = await link.read(DDE, 0xF150).catch(() => null);
            if (!u || u[0] !== 0x62 || u.length < 6) return null;
            index = [u[3], u[4], u[5]].map((x) => hex(x)).join('').toUpperCase();
            log.info('engine unit: SGBD index ' + index);
            return DDE_INDEXES.indexOf(index) >= 0 ? 'diesel' : 'other';
        }

        function happened(events) {
            events.forEach((e) => {
                log.info('regeneration: ' + e);
                if (e === 'done') note = { text: 'REGENERATION FINISHED', color: GO, until: Date.now() + NOTE_MS };
                else if (e === 'start') note = null;
            });
        }

        async function read() {
            if (reading) return;
            reading = true;
            try {
                if (!link) {
                    link = new ReadOnlyDiag(ctx.signals, log);
                    await link.init();
                    reader = new DidReader(link, { ecu: DDE });
                }
                if (!kind) kind = await engineKind();
                const full = !real.running || Date.now() - lastFull >= FULL_MS;
                const keys = full ? ALL : FAST, s = { t: Date.now() };
                for (const k of keys) s[k] = await reader.value(k, DIDS[k]);
                if (full) lastFull = Date.now();
                if (keys.some((k) => s[k] !== null)) { error = ''; happened(real.update(s)); }
                else error = link.error ? String(link.error) : kind === 'other' ? 'engine unit ' + index + ' is not a B47 / B57 diesel' : 'the engine unit has none of these values';
            } catch (e) {
                error = String((e && e.message) || e);
                log.warn('read: ' + error);
            }
            lastRead = Date.now(); reading = false;
        }

        const shown = () => ui.isVisible('MAIN') || !!(ctx.widget && ctx.widget.active());
        setInterval(() => {
            const now = Date.now();
            if (note && now > note.until) note = null;
            if (useDemo()) { happened(demo.update(demoSample(now))); return; }
            const d = car.data(), on = G.isNum(d.rpm) && d.rpm > ENGINE_RPM;
            if (!on) {
                // nothing is read with the engine off, so the car can sleep
                if (wasOn && !offSince) offSince = now;
                if (offSince && now - offSince > OFF_MS) { happened(real.engineOff(offSince)); offSince = 0; wasOn = false; }
                return;
            }
            if (!wasOn && link) link.wake(DDE);          // a new start: ask again a unit that had stopped answering
            wasOn = true; offSince = 0;
            if (!shown() && !settings.get('watch') && !real.running) return;
            const every = real.running ? REGEN_MS : shown() ? SHOWN_MS : HIDDEN_MS;
            if (now - lastRead >= every) read();
        }, 1000);

        /* ---------- what to say ---------- */
        /** The one line that matters: { text, sub, color, alarm }. */
        function status(m, t) {
            const v = m.last, run = m.running;
            if (run) {
                const min = Math.max(0, Math.round((Date.now() - run.at) / 60000));
                return { text: 'REGENERATION RUNNING', sub: 'Keep driving, don\'t switch off' + (useDemo() ? '' : ' - ' + min + ' min so far'), color: t.warn, alarm: true };
            }
            if (note) return { text: note.text, sub: 'Soot now ' + G.fmt(v.soot, 1) + ' g', color: note.color };
            if (m.interrupted) return { text: 'LAST REGENERATION WAS CUT SHORT', sub: 'A longer drive lets the next one finish', color: t.warn };
            if (!useDemo() && error) return { text: 'NO DATA', sub: error, color: t.dim };
            if (!G.isNum(v.soot)) {
                const off = !useDemo() && !(car.data().rpm > ENGINE_RPM);
                return { text: off ? 'ENGINE OFF' : 'READING...', sub: off ? 'Read while the engine runs' : 'Asking the engine unit', color: t.dim };
            }
            const f = m.forecast();
            return { text: 'FILTER OK', sub: f ? (f.km > 0 ? 'Next regeneration in about ' + km(f.km) : 'Next regeneration is due') : 'No regeneration running', color: GO };
        }
        const km = (x) => (G.isNum(x) ? Math.round(x).toLocaleString('en-US').replace(/,/g, ' ') + ' km' : '--');
        const num = (x, dec, unit) => (G.isNum(x) ? G.fmt(x, dec) + (unit ? ' ' + unit : '') : '--');
        const two = (n) => String(n).padStart(2, '0');
        const when = (ms) => { const d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '  ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
        const sootColor = (t, soot) => (!G.isNum(soot) ? t.dim : soot >= settings.get('sootMax') * 0.8 ? t.warn : t.text);
        // a slow pulse for the warning (0.55 .. 1)
        const pulse = () => 0.775 + 0.225 * Math.sin(Date.now() / 320);

        /* ---------- the Filter page ---------- */
        function row(cv, t, x, w, y, label, value, col) {
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(value, x + w, y, 28, col || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
        }
        function big(cv, t, x, y, value, dec, unit, col) {
            const s = G.fmt(value, dec);
            const w = cv.text(s, x, y, 88, G.isNum(value) ? col || t.text : t.dim, { font: 'num' });
            cv.text(unit, x + w + 10, y, 30, t.dim, { font: 'bold' });
        }

        function drawFilter(cv, t) {
            const m = mon(), v = m.last, st = status(m, t), max = settings.get('sootMax');
            // the status line across the top
            const a = st.alarm ? pulse() : 1;
            cv.roundRect(24, 56, 1552, 68, 10, withAlpha(st.color, st.alarm ? 0.30 * a : 0.14));
            cv.fillRect(24, 56, 10, 68, withAlpha(st.color, a));
            cv.text(st.text, 58, 102, 34, st.color, { font: 'bold', spacing: 1.5 });
            cv.text(st.sub, 1552, 100, 24, st.alarm ? t.text : t.dim, { align: 'right' });

            // soot
            G.panel(cv, t, 24, 140, 500, 372, 'Soot in the filter');
            big(cv, t, 48, 286, v.soot, 1, 'g', sootColor(t, v.soot));
            G.bar(cv, t, 48, 306, 452, 60, { head: false, value: v.soot, min: 0, max, step: max / 5, color: m.running ? 'warn' : !G.isNum(v.soot) ? null : v.soot >= max ? 'crit' : v.soot >= max * 0.8 ? 'warn' : 'accent2' });
            row(cv, t, 48, 452, 432, 'OIL ASH', num(v.ash, 1, 'g'));
            row(cv, t, 48, 452, 476, 'PRESSURE ACROSS', num(v.dp, 0, 'hPa'));

            // exhaust
            const lim = m.regenTemp, hot = G.isNum(v.temp) && v.temp >= lim;
            G.panel(cv, t, 544, 140, 500, 372, 'Exhaust before the filter');
            big(cv, t, 568, 286, v.temp, 0, '°C', hot ? t.warn : null);
            G.bar(cv, t, 568, 306, 452, 60, { head: false, value: v.temp, min: 0, max: 800, step: 200, ramp: 'hot' });
            row(cv, t, 568, 452, 432, 'REGENERATION ABOVE', lim + ' °C');
            row(cv, t, 568, 452, 476, 'NOW', !G.isNum(v.temp) ? '--' : hot ? 'BURNING' : 'NORMAL', hot ? t.warn : null);

            // regenerations
            const f = m.forecast();
            G.panel(cv, t, 1064, 140, 512, 372, 'Regenerations');
            [['NEXT IN ABOUT', f ? (f.km > 0 ? km(f.km) : 'DUE') : '--', f && f.km === 0 ? t.warn : null],
                ['SINCE THE LAST', km(v.sinceKm)],
                ['FUEL SINCE', num(v.sinceL, 1, 'l')],
                ['ENGINE TIME SINCE', num(v.sinceH, 1, 'h')],
                ['AVERAGE EVERY', km(v.avgKm)],
                ['TOTAL', num(v.regens, 0)]]
                .forEach((r, i) => row(cv, t, 1088, 464, 222 + i * 51, r[0], r[1], r[2]));
        }

        /* ---------- the History page ---------- */
        function drawHistory(cv, t) {
            const m = mon(), s = m.stats();
            G.panel(cv, t, 24, 56, 1060, 456, 'Regenerations seen');
            const rows = m.history.slice(-8).reverse().map((e) => [
                when(e.at),
                e.kind === 'done' ? { text: e.unseen ? 'DONE (NOT WATCHED)' : 'DONE', color: GO } : { text: 'CUT SHORT', color: 'warn' },
                G.isNum(e.min) ? e.min + ' min' : '--',
                G.isNum(e.sootBefore) || G.isNum(e.sootAfter) ? G.fmt(e.sootBefore, 1) + ' > ' + G.fmt(e.sootAfter, 1) + ' g' : '--',
                G.isNum(e.km) ? km(e.km) : '--',
            ]);
            G.table(cv, t, 48, 118, 1012, [
                { label: 'When', w: 220 }, { label: 'Result', w: 300, font: 'bold' }, { label: 'Took', w: 130, align: 'right' },
                { label: 'Soot', w: 210, align: 'right' }, { label: 'Distance before', w: 152, align: 'right' },
            ], rows, { rowH: 44, empty: 'None yet. They are logged while the engine runs.' });

            G.panel(cv, t, 1104, 56, 472, 456, 'Summary');
            [['LOGGED', String(s.seen)], ['FINISHED', String(s.done)], ['CUT SHORT', String(s.interrupted), s.interrupted ? t.warn : null],
                ['USUALLY TAKES', G.isNum(s.avgMin) ? Math.round(s.avgMin) + ' min' : '--'],
                ['DISTANCE BETWEEN', G.isNum(s.avgKm) ? km(s.avgKm) : '--'],
                ['ENGINE UNIT', useDemo() ? 'DEMO' : index || '--']]
                .forEach((r, i) => row(cv, t, 1128, 424, 140 + i * 56, r[0], r[1], r[2]));
        }

        /* ---------- screen ---------- */
        let page = 0;
        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawFilter(cv, t); else drawHistory(cv, t);
            G.frame(cv, t, PAGES, page, [useDemo() && { text: 'DEMO' }, mon().running && { text: 'REGEN' }]);
            await ui.image('MAIN_GFX', cv);
        }
        const flip = () => { page = (page + 1) % PAGES.length; };
        ui.onClick('BTN_PAGE', flip);
        ctx.onTab((i) => { if (i >= 0 && i < PAGES.length) page = i; });
        ctx.hideButton('BTN_PAGE');                     // where the kit runs the screen, the tabs do it
        ui.onVisible((name, on) => { if (name === 'MAIN' && on && !useDemo()) lastRead = 0; });   // opened: read now
        ctx.loop('MAIN', 4, render);

        /* ---------- home-screen widget ---------- */
        const wcan = {}, wtext = {};
        /* The small widget shows no picture, only the layout's own text lines and progress bar. */
        function widgetCells(inst, m) {
            const v = m.last, f = m.forecast(), on = !inst.big, max = settings.get('sootMax');
            const cells = {
                Title: [on ? 'Diesel' : '', 'Text'],
                TextRecordings: [on ? (m.running ? 'REGENERATION' : 'Soot ' + G.fmt(v.soot, 1) + ' g') : '', 'Text'],
                TextCam: [on ? (m.running ? 'Keep driving' : m.interrupted ? 'Last one cut short' : '') : '', 'Text'],
                ProgressbarVisible: [on, 'Bool'],
                Progress: [on && G.isNum(v.soot) ? Math.round(G.clamp(v.soot / max, 0, 1) * 100) : 0, 'Float'],
                TimeElapsed: [on ? 'Next ' + (f ? f.km + ' km' : '--') : '', 'Text'],
                TimeRemaining: [on ? 'Last ' + (G.isNum(v.sinceKm) ? Math.round(v.sinceKm) + ' km' : '--') : '', 'Text'],
            };
            const prev = wtext[inst.spawnId] || (wtext[inst.spawnId] = {});
            Object.keys(cells).forEach((k) => {
                const s = JSON.stringify(cells[k][0]);
                if (prev[k] === s) return;
                prev[k] = s;
                ctx.widget.set(inst.spawnId, k, cells[k][0], cells[k][1]);
            });
        }
        function renderWidget(inst) {
            const t = ctx.theme(), m = mon(), v = m.last, st = status(m, t);
            if (inst) widgetCells(inst, m);
            const sw = ctx.spec.startWidget || {};
            const [w, h] = sw.size || [384, 256], [sx, sy] = sw.safe || [0.09, 0.17], scale = sw.scale || 1;
            const key = w + 'x' + h;
            const cv = (wcan[key] = wcan[key] || new ScaledCanvas(w, h, scale)).clear([0, 0, 0, 0]);
            const x0 = Math.round(w * sx), x1 = w - x0, y0 = Math.round(h * sy), y1 = h - y0, iw = x1 - x0;
            if (st.alarm) cv.roundRect(x0 - 8, y0 - 4, iw + 16, y1 - y0 + 8, 10, withAlpha(st.color, 0.28));
            // top: what is going on
            const head = st.alarm ? 'REGENERATION' : m.interrupted ? 'CUT SHORT' : 'DPF';
            cv.text(head, x0, y0 + 18, 18, st.alarm || m.interrupted ? t.warn : t.dim, { font: 'bold', spacing: 1.5 });
            if (useDemo()) cv.text('DEMO', x1, y0 + 18, 13, t.warn, { font: 'bold', spacing: 1, align: 'right' });
            // soot, big
            const ky = y0 + 88;
            const vw = cv.text(G.fmt(v.soot, 1), x0, ky, 64, G.isNum(v.soot) ? sootColor(t, v.soot) : t.dim, { font: 'num' });
            cv.text('g', x0 + vw + 6, ky, 22, t.dim, { font: 'bold' });
            if (st.alarm) cv.text(G.fmt(v.temp, 0) + ' °C', x1, ky, 26, t.warn, { font: 'bold', align: 'right' });
            // bar: soot against the gauge's end
            const max = settings.get('sootMax'), part = G.isNum(v.soot) ? G.clamp(v.soot / max, 0, 1) : 0;
            cv.roundRect(x0, ky + 14, iw, 10, 5, withAlpha(t.track, 0.9));
            if (part > 0.02) cv.roundRect(x0, ky + 14, iw * part, 10, 5, st.alarm ? t.warn : part >= 0.8 ? t.warn : GO);
            // bottom: keep driving, or the two distances
            const yb = y1 - 26;
            if (st.alarm) {
                cv.text('KEEP DRIVING', (x0 + x1) / 2, yb + 22, 22, t.text, { font: 'bold', spacing: 1.5, align: 'center' });
            } else {
                const f = m.forecast();
                cv.text('NEXT IN', x0, yb, 13, t.dim, { font: 'bold', spacing: 1 });
                cv.text(f ? (f.km > 0 ? f.km + ' km' : 'DUE') : '--', x0, yb + 24, 21, t.text, { font: 'bold' });
                cv.text('SINCE LAST', x1, yb, 13, t.dim, { font: 'bold', spacing: 1, align: 'right' });
                cv.text(G.isNum(v.sinceKm) ? Math.round(v.sinceKm) + ' km' : '--', x1, yb + 24, 21, t.text, { font: 'bold', align: 'right' });
            }
            return cv.canvas;
        }
        if (ctx.widget) {
            ctx.widget.loop(() => (mon().running ? 3 : 1), renderWidget);
            ctx.widget.onChange((why) => {
                if (why === 'resized' || why === 'placed') Object.keys(wtext).forEach((k) => delete wtext[k]);
                if (ctx.widget.active() && !useDemo()) lastRead = 0;
            });
        }

        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
