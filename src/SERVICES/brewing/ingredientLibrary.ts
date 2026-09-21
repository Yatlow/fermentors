export type IngredientCategory =
  | "grain"
  | "hop"
  | "yeast"
  | "other";

export type IngredientLotStatus =
  | "current"
  | "next"
  | "received"
  | "ended"
  | "unknown";

export type IngredientLot = {
  id: string;
  lotNumber: string;
  supplier?: string;
  alpha?: number;
  bbe?: string;
  receivedDate?: string;
  startedDate?: string;
  status?: IngredientLotStatus;
  active: boolean;
};

export type IngredientDefinition = {
  id: string;
  name: string;
  category: IngredientCategory;
  lots: IngredientLot[];
};

export const DEFAULT_INGREDIENT_LIBRARY: IngredientDefinition[] = [
  {
    id: "pils",
    name: "Pils",
    category: "grain",
    lots: [
      {
        id: "pils-avangard-212325",
        supplier: "Avangard",
        lotNumber: "212325",
        status: "current",
        active: true,
      },
      {
        id: "pils-weyermann-c169-21110025",
        supplier: "Weyermann",
        lotNumber: "C169-21110025",
        receivedDate: "2026-07-20",
        status: "received",
        active: false,
      },
    ],
  },
  {
    id: "wheat",
    name: "Wheat",
    category: "grain",
    lots: [
      {
        id: "wheat-avangard-212326",
        supplier: "Avangard",
        lotNumber: "212326",
        status: "current",
        active: true,
      },
    ],
  },
  {
    id: "caramunich2",
    name: "Caramunich 2",
    category: "grain",
    lots: [
      {
        id: "cm2-weyermann-b315-21247025",
        supplier: "Weyermann",
        lotNumber: "B315-21247025",
        status: "ended",
        active: false,
      },
      {
        id: "cm2-weyermann-c168-21247025",
        supplier: "Weyermann",
        lotNumber: "C168-21247025",
        receivedDate: "2026-07-20",
        status: "current",
        active: true,
      },
    ],
  },
  {
    id: "carahell",
    name: "CaraHell",
    category: "grain",
    lots: [
      {
        id: "carahell-weyermann-b324-21242025",
        supplier: "Weyermann",
        lotNumber: "B324-21242025",
        status: "current",
        active: true,
      },
      {
        id: "carahell-weyermann-c156-21242025",
        supplier: "Weyermann",
        lotNumber: "C156-21242025",
        receivedDate: "2026-07-20",
        status: "received",
        active: false,
      },
    ],
  },
  {
    id: "cascade",
    name: "Cascade",
    category: "hop",
    lots: [
      {
        id: "cascade-haas-pe02783",
        supplier: "HAAS",
        lotNumber: "PE02783",
        alpha: 6.9,
        status: "ended",
        active: false,
      },
      {
        id: "cascade-haas-pe05132",
        supplier: "HAAS",
        lotNumber: "PE05132",
        alpha: 5.5,
        startedDate: "2026-08-10",
        status: "current",
        active: true,
      },
    ],
  },
  {
    id: "citra",
    name: "Citra",
    category: "hop",
    lots: [
      {
        id: "citra-yakima-ended",
        supplier: "Yakima",
        lotNumber: "",
        alpha: 1.4,
        status: "ended",
        active: false,
      },
      {
        id: "citra-haas-pe05141",
        supplier: "HAAS",
        lotNumber: "PE05141",
        alpha: 13.4,
        status: "current",
        active: true,
      },
    ],
  },
  {
    id: "talus",
    name: "Talus",
    category: "hop",
    lots: [
      {
        id: "talus-yakima-p92-hutal2115",
        supplier: "Yakima",
        lotNumber: "P92-HUTAL2115",
        alpha: 9.3,
        status: "current",
        active: true,
      },
      {
        id: "talus-haas-next",
        supplier: "HAAS",
        lotNumber: "",
        alpha: 7.9,
        status: "next",
        active: false,
      },
    ],
  },
  {
    id: "magnum",
    name: "Magnum",
    category: "hop",
    lots: [
      {
        id: "magnum-barthhaas-1001847",
        supplier: "BarthHaas",
        lotNumber: "1001847",
        alpha: 14,
        status: "current",
        active: true,
      },
    ],
  },
  {
    id: "hersbruker",
    name: "Hersbruker",
    category: "hop",
    lots: [
      {
        id: "hersbruker-barthhaas-1002475",
        supplier: "BarthHaas",
        lotNumber: "1002475",
        alpha: 2.5,
        status: "current",
        active: true,
      },
    ],
  },
  {
    id: "s05",
    name: "S-05",
    category: "yeast",
    lots: [
      {
        id: "s05-current",
        lotNumber: "",
        status: "current",
        active: true,
      },
    ],
  },
];

export function activeLot(
  ingredient: IngredientDefinition,
): IngredientLot | undefined {
  return (
    ingredient.lots.find((lot) => lot.active) ??
    ingredient.lots.find((lot) => lot.status === "current")
  );
}
