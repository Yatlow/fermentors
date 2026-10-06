import { collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../../firebase";
import {
  applyProductCatalogOverrides,
  normalizedCatalogStyleKey,
  type EditableCatalogEntry,
} from "./PalletCatalog";

const CATALOG_COLLECTION = "productCatalog";

function entryFromDoc(id: string, data: Record<string, unknown>): EditableCatalogEntry | null {
  const itemType = data.itemType === "kegs" ? "kegs" : "crates";
  const styleKey = String(data.styleKey ?? id.split("__")[0] ?? "").trim().toLocaleLowerCase("he-IL");
  if (!styleKey) return null;
  return {
    id: `${styleKey}__${itemType}`,
    styleKey,
    beerStyle: String(data.beerStyle ?? styleKey).trim(),
    itemType,
    sku: String(data.sku ?? "").trim(),
    displayText: String(data.displayText ?? "").trim(),
    enabled: data.enabled !== false,
  };
}

export function subscribeToProductCatalog(onChange?: () => void): () => void {
  return onSnapshot(collection(db, CATALOG_COLLECTION), (snapshot) => {
    const entries = snapshot.docs
      .map((catalogDoc) => entryFromDoc(catalogDoc.id, catalogDoc.data()))
      .filter((entry): entry is EditableCatalogEntry => entry !== null);
    applyProductCatalogOverrides(entries);
    onChange?.();
  });
}

export async function saveCatalogEntry(entry: Omit<EditableCatalogEntry, "id">): Promise<void> {
  const styleKey = normalizedCatalogStyleKey(entry.styleKey || entry.beerStyle);
  if (!styleKey) throw new Error("יש להזין סגנון בירה");
  if (!entry.sku.trim()) throw new Error('יש להזין מק"ט');
  if (!entry.displayText.trim()) throw new Error("יש להזין תיאור מוצר");
  const id = `${styleKey}__${entry.itemType}`;
  await setDoc(doc(db, CATALOG_COLLECTION, id), {
    styleKey,
    beerStyle: entry.beerStyle.trim(),
    itemType: entry.itemType,
    sku: entry.sku.trim(),
    displayText: entry.displayText.trim(),
    enabled: entry.enabled,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}
