from pathlib import Path

# A) Preserve recommendation packaging type as the editor default.
p = Path('src/components/planning/PlanningWeeklyRecommendationsEnhanced.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace(
'    const [packStyle, setPackStyle] = useState<string | null | undefined>(undefined);\n',
'    const [packStyle, setPackStyle] = useState<string | null | undefined>(undefined);\n    const [preferredPackType, setPreferredPackType] = useState<"crates" | "kegs" | undefined>(undefined);\n', 1)
s = s.replace(
'    function openPackEditor(style?: string) {\n        setModalMessage("");',
'    function openPackEditor(style?: string, preferredType?: "crates" | "kegs") {\n        setModalMessage("");\n        setPreferredPackType(preferredType);', 1)
s = s.replace(
'        chooseStyle(style);\n    }\n\n    function chooseStyle(style: string) {',
'        chooseStyle(style, preferredType);\n    }\n\n    function chooseStyle(style: string, preferredType = preferredPackType) {', 1)
s = s.replace(
'        const defaultProduct = products[0];',
'        const defaultProduct = (preferredType ? products.find((item) => item.type === preferredType) : undefined) ?? products[0];', 1)
# Recommendation card click: infer packaging type from the clicked recommendation text.
old = '''                if (style) {
                    event.preventDefault();
                    event.stopPropagation();
                    openPackEditor(style);
                }'''
new = '''                if (style) {
                    event.preventDefault();
                    event.stopPropagation();
                    const skuText = sku.textContent ?? "";
                    const preferredType = skuText.includes("חביות") ? "kegs" : skuText.includes("בקבוקים") || skuText.includes("ארגז") ? "crates" : undefined;
                    openPackEditor(style, preferredType);
                }'''
if old not in s:
    raise SystemExit('packaging recommendation click anchor not found')
s = s.replace(old, new, 1)
# Reset preferred type when changing weeks/closing generic editor.
s = s.replace('                setPackStyle(undefined);\n                setRows([]);', '                setPackStyle(undefined);\n                setPreferredPackType(undefined);\n                setRows([]);', 1)
p.write_text(s, encoding='utf-8')

# B/C) Replace browser confirm with an in-app modal and add breathing room.
p = Path('src/components/planning/PlanningGanttWeekEditorModal.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace('import { useEffect, useRef, type ComponentProps } from "react";', 'import { useEffect, useRef, useState, type ComponentProps } from "react";', 1)
s = s.replace('  const hostRef = useRef<HTMLDivElement>(null);', '  const hostRef = useRef<HTMLDivElement>(null);\n  const [confirmOverflow, setConfirmOverflow] = useState(false);', 1)
old = '''      approve.onclick = () => {
        const confirmed = window.confirm("כל המיכלים הזמינים לשבוע כבר תפוסים. להוסיף בישול נוסף שידרוש שיבוץ מפורש למיכל שאינו פנוי כרגע?");
        if (!confirmed) return;
        normalAdd.disabled = false;
        normalAdd.click();
        normalAdd.disabled = true;
      };'''
new = '''      approve.onclick = () => setConfirmOverflow(true);'''
if old not in s:
    raise SystemExit('window.confirm anchor not found')
s = s.replace(old, new, 1)
# Insert explicit confirm handler before second effect.
anchor = '''  useEffect(() => {
    const previousOverflow = document.body.style.overflow;'''
handler = '''  const approveOverflowBrew = () => {
    const host = hostRef.current;
    const normalAdd = [...(host?.querySelectorAll<HTMLButtonElement>(".bp-week-brew-card button") ?? [])]
      .find((button) => button.textContent?.trim() === "+ הוסף בישול");
    if (!normalAdd) {
      setConfirmOverflow(false);
      return;
    }
    normalAdd.disabled = false;
    normalAdd.click();
    normalAdd.disabled = true;
    setConfirmOverflow(false);
  };

'''
if anchor not in s:
    raise SystemExit('overflow handler anchor not found')
s = s.replace(anchor, handler + anchor, 1)
# Render app modal inside portal, not native browser confirm.
anchor = '''        <div className="bp-gantt-editor-body" ref={hostRef}>
          <PlanningWeeklyRecommendationsEnhanced'''
replacement = '''        <div className="bp-gantt-editor-body" ref={hostRef}>
          <PlanningWeeklyRecommendationsEnhanced'''
# no-op anchor validation
if anchor not in s:
    raise SystemExit('editor body anchor not found')
# Add modal after body closing, before section close.
old = '''        </div>
      </section>
    </div>
  );'''
new = '''        </div>
        {confirmOverflow && <div className="bp-inline-confirm-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConfirmOverflow(false);
        }}>
          <section className="bp-inline-confirm" role="alertdialog" aria-modal="true" aria-labelledby="brew-overflow-title">
            <h3 id="brew-overflow-title">שיבוץ במיכל שאינו פנוי</h3>
            <p>כל המיכלים הזמינים לשבוע כבר תפוסים. הבישול הנוסף ידרוש שיבוץ מפורש למיכל שאינו פנוי כרגע.</p>
            <div className="bp-inline-confirm-actions">
              <button type="button" onClick={() => setConfirmOverflow(false)}>ביטול</button>
              <button type="button" className="bp-action-warning" onClick={approveOverflowBrew}>אשר והוסף בישול</button>
            </div>
          </section>
        </div>}
      </section>
    </div>
  );'''
if old not in s:
    raise SystemExit('modal render anchor not found')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# Styling: padding for focused editor + in-app confirmation.
p = Path('src/components/planning/planningPackagingModal.css')
s = p.read_text(encoding='utf-8')
s += '''\n\n/* Focused weekly editor breathing room + non-native overflow confirmation. */\n.bp-gantt-editor-body {\n  padding: 14px 18px 18px;\n}\n\n.bp-inline-confirm-backdrop {\n  position: absolute;\n  inset: 0;\n  z-index: 20;\n  display: grid;\n  place-items: center;\n  padding: 18px;\n  background: rgba(15, 23, 42, 0.28);\n  border-radius: inherit;\n}\n\n.bp-inline-confirm {\n  width: min(460px, 100%);\n  background: #fff;\n  border-radius: 14px;\n  padding: 20px;\n  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22);\n}\n\n.bp-inline-confirm h3 { margin: 0 0 8px; }\n.bp-inline-confirm p { margin: 0; line-height: 1.55; }\n.bp-inline-confirm-actions { display: flex; gap: 8px; margin-top: 18px; }\n\n@media (max-width: 640px) {\n  .bp-gantt-editor-body { padding: 10px 12px 14px; }\n  .bp-inline-confirm-backdrop { padding: 12px; }\n}\n'''
p.write_text(s, encoding='utf-8')
print('Applied packaging default type, editor padding, and in-app overflow confirmation.')
