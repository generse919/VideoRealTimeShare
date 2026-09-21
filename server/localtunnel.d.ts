/**
 * localtunnel は型定義を同梱していないため、利用する範囲だけ宣言する。
 * (https://github.com/localtunnel/localtunnel)
 */
declare module "localtunnel" {
  interface LocaltunnelOptions {
    port: number;
    subdomain?: string;
    host?: string;
  }
  interface Localtunnel {
    url: string;
    close(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }
  export default function localtunnel(options: LocaltunnelOptions): Promise<Localtunnel>;
}
