export type BrewExecutionBlock = {
  fields: Record<string, string>;
};

export type BrewExecution = {
  batchNumber: string;
  activeBlockIndex: number;
  blocks: Record<string, BrewExecutionBlock>;
  updatedAt: string;
};

function emptyExecution(batchNumber: string): BrewExecution {
  return {
    batchNumber,
    activeBlockIndex: 1,
    blocks: {},
    updatedAt: new Date().toISOString(),
  };
}

function key(batchNumber: string) {
  return `fermentors:brewing-sandbox:execution:${batchNumber}:v1`;
}

export function loadSandboxExecution(batchNumber: string): BrewExecution {
  try {
    const raw = window.localStorage.getItem(key(batchNumber));
    if (!raw) return emptyExecution(batchNumber);
    const parsed = JSON.parse(raw) as BrewExecution;
    return parsed?.batchNumber === batchNumber ? parsed : emptyExecution(batchNumber);
  } catch {
    return emptyExecution(batchNumber);
  }
}

export function saveSandboxExecution(execution: BrewExecution): BrewExecution {
  const next = {
    ...execution,
    updatedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(key(execution.batchNumber), JSON.stringify(next));
  return next;
}

export function setSandboxExecutionField(
  execution: BrewExecution,
  blockIndex: number,
  field: string,
  value: string,
): BrewExecution {
  const blockKey = String(blockIndex);
  return saveSandboxExecution({
    ...execution,
    blocks: {
      ...execution.blocks,
      [blockKey]: {
        fields: {
          ...(execution.blocks[blockKey]?.fields || {}),
          [field]: value,
        },
      },
    },
  });
}

export function setSandboxExecutionActiveBlock(
  execution: BrewExecution,
  activeBlockIndex: number,
): BrewExecution {
  return saveSandboxExecution({ ...execution, activeBlockIndex });
}
