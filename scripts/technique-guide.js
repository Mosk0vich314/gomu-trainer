/* In-app technique reader. Content/styles/models load once, on first use, and
   are precached by the service worker for gym use without a connection. */
(() => {
    const sections = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', principles: 'Principles', brace: 'Bracing', you: 'Your build', coach: 'Self-coaching' };
    let dialog, root, models, loading, ready = false, requested = 'bench', opener, previousOverflow;

    window.getTechniqueLift = function(name) {
        const canonical = typeof normalizeExName === 'function' ? normalizeExName(name) : name;
        const n = String(canonical || '').toLowerCase().replace(/[-_]/g, ' ');
        // These movements need their own instruction, not the competition-lift guide.
        if (/\b(romanian|rdl|stiff|single|split|bulgarian|goblet|hack|machine|smith|dumbbell|db|row|fly|step|dips?|hip thrust)\b/.test(n)) return null;
        if (/\bbench\b|\((bench)\)$/.test(n) || /\b(larsen|spoto|board) press\b/.test(n)) return 'bench';
        if (/\bsquat\b/.test(n)) return 'squat';
        if (/\bdeadlift\b/.test(n)) return 'deadlift';
        return null;
    };

    function stopPlayers() { if (models) models.stop(); }

    function createDialog() {
        dialog = document.createElement('dialog');
        dialog.id = 'technique-guide';
        dialog.setAttribute('aria-label', 'Exercise technique guide');
        dialog.setAttribute('data-no-tab-swipe', '');
        const host = document.createElement('div');
        host.className = 'technique-host';
        dialog.append(host);
        document.body.append(dialog);
        root = host.attachShadow({ mode: 'open' });
        dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
        dialog.addEventListener('close', () => {
            stopPlayers();
            document.body.style.overflow = previousOverflow;
            if (opener && opener.isConnected) opener.focus({ preventScroll: true });
        });
        document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayers(); });
    }

    function showStatus(message, retry = false) {
        root.innerHTML = '<style>:host{display:block;padding:24px;font:16px "DM Sans",sans-serif;color:var(--text-main)}button{font:inherit;color:var(--text-main);background:var(--input-bg);border:1px solid var(--border);border-radius:10px;min-height:44px;padding:8px 16px;margin-right:8px}p{line-height:1.6}</style><p role="status"></p><button type="button" data-close>Back to workout</button>' + (retry ? '<button type="button" data-retry>Try again</button>' : '');
        root.querySelector('p').textContent = message;
        root.querySelector('[data-close]').onclick = () => dialog.close();
        if (retry) root.querySelector('[data-retry]').onclick = () => loadGuide();
    }

    function showSection(id, focus = false) {
        if (!sections[id]) return;
        requested = id;
        stopPlayers();
        root.querySelectorAll('section.lift').forEach(section => { section.hidden = section.id !== id; });
        root.querySelectorAll('[data-section]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.section === id)));
        const section = root.getElementById(id);
        root.querySelector('.reader').scrollTop = 0;
        if (focus) section.querySelector('h2').focus({ preventScroll: true });
    }

    function organizeContent() {
        root.querySelectorAll('section.lift').forEach(section => {
            section.hidden = true;
            const heading = section.querySelector('h2');
            heading.tabIndex = -1;
            if (!['squat', 'bench', 'deadlift'].includes(section.id)) return;
            // Put actionable cues first; keep the complete source in expandable groups.
            const cues = section.querySelector('.cues').parentElement;
            cues.classList.add('quick-cues');
            cues.querySelector('h3').textContent = 'Keep in mind';
            section.querySelector('.lift-head').after(cues);
            [...section.children].forEach(child => {
                if (child.classList.contains('lift-head') || child === cues) return;
                let label;
                if (child.classList.contains('mine')) label = 'Your setup estimate';
                else if (child.querySelector('.rules')) label = 'Sticking points & competition rules';
                else if (child.querySelector('table')) label = 'Common faults & fixes';
                else if (child.querySelector('input[type="range"]')) label = child.querySelector('ol.steps') ? 'Setup & interactive model' : 'Interactive lift models';
                else if (child.querySelector('ol.steps')) label = 'Setup & execution';
                else label = 'Technique diagrams';
                const details = document.createElement('details');
                details.className = 'guide-topic';
                const summary = document.createElement('summary');
                summary.textContent = label;
                child.before(details);
                details.append(summary, child);
                // Stop animations when their containing topic is folded away.
                details.addEventListener('toggle', () => { if (!details.open) stopPlayers(); });
            });
        });
        root.querySelectorAll('.tw').forEach(table => {
            table.tabIndex = 0;
            table.setAttribute('role', 'region');
            table.setAttribute('aria-label', 'Scrollable reference table');
        });
    }

    async function loadGuide() {
        if (ready || loading) return loading;
        showStatus('Loading technique guide…');
        loading = (async () => {
            try {
                const fetchText = async path => {
                    const response = await fetch(path);
                    if (!response.ok) throw new Error('Guide resource unavailable');
                    return response.text();
                };
                const [content, primitives, theme, runtime] = await Promise.all([
                    fetchText('./assets/technique-manual.json'), fetchText('./styles/technique-content.css'),
                    fetchText('./styles/technique-guide.css'), import('./technique-models.js')
                ]);
                const html = JSON.parse(content).html;
                if (typeof html !== 'string') throw new Error('Invalid guide content');
                root.innerHTML = `<style>${primitives}\n${theme}</style>
                    <header class="guide-header"><div><span class="guide-label">Big Three</span><strong>Technique guide</strong></div><button class="guide-close" type="button" aria-label="Close technique guide">✕</button></header>
                    <nav class="guide-nav" aria-label="Technique sections">${Object.entries(sections).map(([id, label]) => `<button type="button" data-section="${id}" aria-pressed="false">${label}</button>`).join('')}</nav>
                    <main class="reader">${html}<p class="guide-credit">From your Big Three Technique Manual. Shared fundamentals also apply to lift variations. Schematics are simplified 2D models that illustrate trends, not exact predictions for your body. Competition rules are IPF-style summaries; check your federation’s current rulebook before a meet.</p></main>`;
                organizeContent();
                models = runtime.initTechniqueModels(root);
                root.querySelector('.guide-close').onclick = () => dialog.close();
                root.addEventListener('click', event => {
                    const button = event.target.closest('[data-section]');
                    const link = event.target.closest('a[href^="#"]');
                    if (button) showSection(button.dataset.section, true);
                    if (link && sections[link.hash.slice(1)]) { event.preventDefault(); showSection(link.hash.slice(1), true); }
                });
                ready = true;
                showSection(requested);
                if (dialog.open) root.querySelector('.guide-close').focus({ preventScroll: true });
            } catch (error) {
                stopPlayers();
                showStatus('The guide could not load. Connect once to download it, then it will be available offline.', true);
                console.warn('Technique guide:', error);
            } finally { loading = null; }
        })();
        return loading;
    }

    window.openTechniqueGuide = function(id, trigger) {
        if (!sections[id]) return;
        requested = id;
        if (!dialog) createDialog();
        if (!dialog.open) {
            opener = trigger || document.activeElement;
            previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            dialog.showModal();
        }
        if (ready) { showSection(id); root.querySelector('.guide-close').focus({ preventScroll: true }); }
        else loadGuide();
    };
})();
