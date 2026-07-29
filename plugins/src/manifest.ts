import { z } from "zod";

const pluginId = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/,
    "Plugin ID must be a lowercase reverse-domain identifier."
  );

export const pluginManifestSchema = z
  .object({
    a1ApiVersion: z.string().trim().min(1),
    dependencies: z.record(pluginId, z.string().trim().min(1)).default({}),
    description: z.string().trim().min(1).max(500),
    id: pluginId,
    name: z.string().trim().min(1).max(100),
    permissions: z
      .array(z.string().trim().min(1))
      .max(100)
      .refine(
        (permissions) => new Set(permissions).size === permissions.length,
        "Plugin permissions must be unique."
      )
      .default([]),
    version: z.string().trim().min(1)
  })
  .strict();

export type PluginManifest = Readonly<z.infer<typeof pluginManifestSchema>>;

export function validatePluginManifest(manifest: PluginManifest): PluginManifest {
  return pluginManifestSchema.parse(manifest);
}
