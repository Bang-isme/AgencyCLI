import { CostGovernor } from "@agency/governance";
import { ProviderSupervisor } from "@agency/governance";

export const globalCostGovernor = new CostGovernor(5.00); // $5.00 default budget
export const globalProviderSupervisor = new ProviderSupervisor("anthropic", ["openai", "gemini"]);
