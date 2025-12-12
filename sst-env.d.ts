const resources: Record<string, string | SSTSecret> = {
  PosthogToken: sst.secret("POSTHOG_TOKEN"),
};

declare module "sst" {
  export interface Resource {
    Server: cloudflare.Service;
  }
}