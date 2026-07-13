import { capabilityRegistry, type CapabilityTier, type CapabilityCategory } from "@agency/core";

export interface SlashMenuItem {
  name: string;
  desc: string;
  tier: CapabilityTier;
  icon?: string;
  category?: CapabilityCategory;
  recoveryAction?: string;
  aliases?: string[];
  isExpander?: boolean;
}

/** Derived dynamically from the core capability catalog; single source of truth. */
export const SLASH_MENU: SlashMenuItem[] = capabilityRegistry.list({ surface: "tui" }).map((capability) => ({
  name: capability.id,
  desc: capability.description,
  tier: capability.tier,
  icon: capability.icon,
  category: capability.category,
  recoveryAction: capability.recoveryAction ?? capability.recovery,
  aliases: capability.aliases,
}));

export function getSlashQuery(
  buffer: string
): { query: string } | null {
  if (!buffer.startsWith("/")) return null;
  const space = buffer.indexOf(" ");
  if (space !== -1) return null;
  return { query: buffer.slice(1).toLowerCase() };
}

export function filterSlashMenu(query: string, isExpanded: boolean = false): SlashMenuItem[] {
  const q = query.toLowerCase();
  const currentList = capabilityRegistry.list({ surface: "tui" }).map((capability) => ({
    name: capability.id,
    desc: capability.description,
    tier: capability.tier,
    icon: capability.icon,
    category: capability.category,
    recoveryAction: capability.recoveryAction ?? capability.recovery,
    aliases: capability.aliases,
  }));

  if (!q) {
    const coreItems = currentList.filter((item) => item.tier === "core");
    const advancedItems = currentList.filter((item) => item.tier === "advanced");
    if (!isExpanded) {
      const expander: SlashMenuItem = {
        name: "more",
        desc: `Expand Advanced capabilities (${advancedItems.length} commands available — press Tab or → to expand)`,
        tier: "advanced",
        icon: "+",
        isExpander: true,
      };
      return [...coreItems, expander];
    }
    return [...coreItems, ...advancedItems];
  }

  const matches = currentList.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.aliases?.some((a) => a.toLowerCase().includes(q)) ||
      item.desc.toLowerCase().includes(q) ||
      (item.category && item.category.toLowerCase().includes(q))
  );

  return matches.sort((a, b) => {
    if (a.tier === "core" && b.tier !== "core") return -1;
    if (a.tier !== "core" && b.tier === "core") return 1;
    return 0;
  });
}
