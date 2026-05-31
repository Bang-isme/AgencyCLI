import { z } from "zod";

export const TeamMemberRoleSchema = z.enum(["lead", "dev", "qa", "devops"]);

export const TeamMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: TeamMemberRoleSchema,
  email: z.string().email().optional(),
});

export const TeamPoliciesSchema = z.object({
  requireApprovalForDeploy: z.boolean(),
  defaultProvider: z.string().optional(),
});

export const TeamConfigSchema = z.object({
  version: z.literal(1),
  teamName: z.string().min(1),
  members: z.array(TeamMemberSchema),
  sharedSkillsRoot: z.string().optional(),
  policies: TeamPoliciesSchema,
});

export type TeamMemberRole = z.infer<typeof TeamMemberRoleSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamPolicies = z.infer<typeof TeamPoliciesSchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;
