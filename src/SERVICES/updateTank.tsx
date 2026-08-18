const GOOGLE_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

type UpdateTankStatusResult = {
  success: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export async function updateTankStatus(
  fermentorID: string | number,
  action: number | string,
  date: string | Date,
  pasivationDate?: string | null
): Promise<UpdateTankStatusResult> {
  if (!fermentorID) {
    throw new Error("Missing fermentorID");
  }

  if (action === undefined || action === null) {
    throw new Error("Missing tank action");
  }

  if (!date) {
    throw new Error("Missing date");
  }

  const payload = {
    // API command
    action: "updateTankStatus",

    // Actual tank status
    tankAction: Number(action),

    fermentorID: String(fermentorID),

    date: new Date(date).toISOString(),

    pasivationDate: pasivationDate || null,
  };

  console.log("Updating tank:", payload);

  const response = await fetch(GOOGLE_SCRIPT_URL, {
    method: "POST",

    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },

    body: JSON.stringify(payload),
  });

  const text = await response.text();

  console.log("Google Apps Script response:", text);

  let result: UpdateTankStatusResult;

  try {
    result = JSON.parse(text) as UpdateTankStatusResult;
  } catch {
    throw new Error(
      "Google Apps Script returned invalid JSON: " + text
    );
  }

  if (!result.success) {
    throw new Error(
      result.error ||
        result.message ||
        "Tank update failed"
    );
  }

  console.log(
    "Tank successfully updated:",
    fermentorID,
    "status:",
    action
  );

  return result;
}