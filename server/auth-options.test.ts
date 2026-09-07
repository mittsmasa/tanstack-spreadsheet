import { describe, expect, it } from "vitest";

import { authOptions } from "./auth-options";

const google = { clientId: "id", clientSecret: "secret" };
const baseURL = "http://localhost:3210";

function pluginIds(options: ReturnType<typeof authOptions>) {
  return options.plugins.map((p) => p.id);
}

describe("authOptions", () => {
  it("uses the real Google provider when no emulator URL is given", () => {
    const options = authOptions({ baseURL, google });
    expect(options.socialProviders?.google).toMatchObject(google);
    expect(pluginIds(options)).toEqual(["jwt", "oauth-provider"]);
  });

  it("swaps Google for the emulator under the same provider id", () => {
    const emulatorUrl = "http://localhost:3210/emulate/google";
    const options = authOptions({ baseURL, google: { ...google, emulatorUrl } });
    expect(options.socialProviders).toBeUndefined();
    expect(pluginIds(options)).toEqual(["generic-oauth", "jwt", "oauth-provider"]);

    const plugin = options.plugins.find((p) => p.id === "generic-oauth");
    if (plugin?.id !== "generic-oauth") throw new Error("generic-oauth plugin missing");
    expect(plugin.options.config).toEqual([
      expect.objectContaining({
        providerId: "google",
        clientId: "id",
        clientSecret: "secret",
        authorizationUrl: `${emulatorUrl}/o/oauth2/v2/auth`,
        tokenUrl: `${emulatorUrl}/oauth2/token`,
        userInfoUrl: `${emulatorUrl}/oauth2/v2/userinfo`,
        accountIssuer: emulatorUrl,
        pkce: true,
      }),
    ]);
    // discovery would make Better Auth verify the HS256 id_token against an empty JWKS
    expect(plugin.options.config[0]).not.toHaveProperty("discoveryUrl");
  });
});
