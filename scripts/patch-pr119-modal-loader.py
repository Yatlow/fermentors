from pathlib import Path
p=Path('src/components/planning/PlanningGantt.tsx')
s=p.read_text(encoding='utf-8')
anchor='  const [dailyTarget, setDailyTarget] = useState<EditorTarget | null>(null);\n'
insert='''  const [isOpeningEditor, setIsOpeningEditor] = useState(false);\n  const openEditor = (target: EditorTarget, daily = false) => {\n    setIsOpeningEditor(true);\n    window.setTimeout(() => {\n      if (daily) setDailyTarget(target);\n      else setEditorTarget(target);\n      window.setTimeout(() => setIsOpeningEditor(false), 0);\n    }, 0);\n  };\n'''
if 'const [isOpeningEditor' not in s:
    if anchor not in s: raise SystemExit('state anchor missing')
    s=s.replace(anchor,anchor+insert,1)
s=s.replace('onClick={() => setEditorTarget({ week: weekId, kind: editableKind })}','onClick={() => openEditor({ week: weekId, kind: editableKind })}')
s=s.replace('onClick={() => setDailyTarget({ week: weekId, kind: editableKind })}','onClick={() => openEditor({ week: weekId, kind: editableKind }, true)}')
# Render once per mode, next to existing pagination overlay.
s=s.replace('{isPaging && <BeerLoader overlay message="מעדכן…" />}','{isPaging && <BeerLoader overlay message="מעדכן…" />}\n        {isOpeningEditor && <BeerLoader overlay message="פותח…" />}',1)
# second occurrence has different indentation but same literal
idx=s.find('{isPaging && <BeerLoader overlay message="מעדכן…" />}', s.find('{isOpeningEditor'))
if idx!=-1:
    end=idx+len('{isPaging && <BeerLoader overlay message="מעדכן…" />}')
    s=s[:end]+'\n      {isOpeningEditor && <BeerLoader overlay message="פותח…" />}' + s[end:]
p.write_text(s,encoding='utf-8')
