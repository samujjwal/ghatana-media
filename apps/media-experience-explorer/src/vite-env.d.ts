declare module "*.css";

interface ImportMetaEnv {
  readonly DEV: boolean;
  /** Optional OIDC sign-in (authorization code + PKCE). Both must be set for the login option to appear. */
  readonly VITE_MEDIA_OIDC_ISSUER?: string;
  readonly VITE_MEDIA_OIDC_CLIENT_ID?: string;
  readonly VITE_MEDIA_OIDC_SCOPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "*.yaml?raw" {
  const content: string;
  export default content;
}
