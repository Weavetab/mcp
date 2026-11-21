import CDP from "chrome-remote-interface";

export type NetworkSecurityDetails = {
  protocol?: string;
  issuer?: string;
  subjectName?: string;
  validFrom?: number;
  validTo?: number;
  cipher?: string;
  keyExchange?: string;
  sanList?: string[];
  certificateId?: number;
};

export type NetworkTimingBreakdown = {
  dnsMs?: number;
  connectMs?: number;
  sslMs?: number;
  sendMs?: number;
  waitMs?: number;
  downloadMs?: number;
  totalMs?: number;
};

export type NetworkFailureDetails = {
  errorText: string;
  canceled?: boolean;
  blockedReason?: string;
};

export type CapturedRequest = {
  url: string;
  method: string;
  status?: number;
  isApi: boolean;
  timestamp?: number;
  securityDetails?: NetworkSecurityDetails;
  timing?: NetworkTimingBreakdown;
  failure?: NetworkFailureDetails;
  _startTimeMonotonic?: number;
  _responseHeadersMonotonic?: number;
};

export type TelemetryReport = {
  networkRequests: CapturedRequest[];
  domMutations: string[];
  navigationOccurred: boolean;
  newUrl?: string;
  toastMessages: string[];
  pageTitle?: string;
  errors: string[];
};

const MAX_REQUESTS = 500;
const MAX_ERRORS = 200;
const MAX_TOASTS = 100;

export class TelemetryCapture {
  private session: CDP.Client;
  private requests = new Map<string, CapturedRequest>();
  private toastMessages: string[] = [];
  private errors: string[] = [];
  private navigationOccurred = false;
  private newUrl?: string;
  private active = false;
  private unsubs: Array<() => void> = [];

  constructor(session: CDP.Client) {
    this.session = session;
  }

  private listen(domain: any, event: string, handler: (params: any) => void) {
    if (!domain) return;
    const ret =
      typeof domain.on === "function"
        ? domain.on(event, handler)
        : typeof domain[event] === "function"
        ? domain[event](handler)
        : undefined;
    if (typeof ret === "function") {
      this.unsubs.push(ret);
    } else if (typeof domain.removeListener === "function") {
      this.unsubs.push(() => domain.removeListener(event, handler));
    }
  }

  private setupListeners() {
    this.listen(this.session.Network, "requestWillBeSent", (params) => {
      if (!this.active) return;
      if (!this.requests.has(params.requestId) && this.requests.size >= MAX_REQUESTS) {
        const oldest = this.requests.keys().next().value;
        if (oldest !== undefined) this.requests.delete(oldest);
      }
      this.requests.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        isApi:
          params.request.url.includes("/api/") ||
          Boolean(params.request.headers?.["Accept"]?.includes("application/json")),
        timestamp: params.wallTime ? params.wallTime * 1000 : Date.now(),
        _startTimeMonotonic: params.timestamp,
      });
    });

    this.listen(this.session.Network, "responseReceived", (params) => {
      if (!this.active) return;
      const req = this.requests.get(params.requestId);
      if (!req) return;

      req.status = params.response.status;
      if (params.response.mimeType?.includes("application/json")) {
        req.isApi = true;
      }

      if (params.response.securityDetails) {
        const sec = params.response.securityDetails;
        req.securityDetails = {
          protocol: sec.protocol,
          issuer: sec.issuer,
          subjectName: sec.subjectName,
          validFrom: sec.validFrom,
          validTo: sec.validTo,
          cipher: sec.cipher,
          keyExchange: sec.keyExchange,
          sanList: sec.sanList,
          certificateId: sec.certificateId,
        };
      }

      if (params.response.timing) {
        const t = params.response.timing;
        const phases: NetworkTimingBreakdown = {};
        if (t.dnsEnd > 0 && t.dnsStart >= 0) phases.dnsMs = Number((t.dnsEnd - t.dnsStart).toFixed(3));
        if (t.connectEnd > 0 && t.connectStart >= 0) phases.connectMs = Number((t.connectEnd - t.connectStart).toFixed(3));
        if (t.sslEnd > 0 && t.sslStart >= 0) phases.sslMs = Number((t.sslEnd - t.sslStart).toFixed(3));
        if (t.sendEnd > 0 && t.sendStart >= 0) phases.sendMs = Number((t.sendEnd - t.sendStart).toFixed(3));
        if (t.receiveHeadersStart > 0 && t.sendEnd > 0) phases.waitMs = Number((t.receiveHeadersStart - t.sendEnd).toFixed(3));
        req.timing = phases;

        const headersEnd = t.receiveHeadersEnd > 0 ? t.receiveHeadersEnd : t.receiveHeadersStart;
        if (t.requestTime && headersEnd > 0) {
          req._responseHeadersMonotonic = t.requestTime + headersEnd / 1000;
        }
      }
    });

    this.listen(this.session.Network, "loadingFinished", (params) => {
      if (!this.active) return;
      const req = this.requests.get(params.requestId);
      if (!req) return;
      const finishTimeMonotonic = params.timestamp;
      if (req._startTimeMonotonic && finishTimeMonotonic) {
        const totalMs = (finishTimeMonotonic - req._startTimeMonotonic) * 1000;
        if (!req.timing) req.timing = {};
        req.timing.totalMs = Number(Math.max(0, totalMs).toFixed(3));

        if (req._responseHeadersMonotonic) {
          const downloadMs = (finishTimeMonotonic - req._responseHeadersMonotonic) * 1000;
          req.timing.downloadMs = Number(Math.max(0, downloadMs).toFixed(3));
        }
      }
    });

    this.listen(this.session.Network, "loadingFailed", (params) => {
      if (!this.active) return;
      const req = this.requests.get(params.requestId);
      if (!req) return;
      req.failure = {
        errorText: params.errorText || "net::ERR_FAILED",
        canceled: params.canceled,
        blockedReason: params.blockedReason,
      };
      if (this.errors.length < MAX_ERRORS) {
        this.errors.push(`[Network Error] ${req.url} failed: ${params.errorText || "net::ERR_FAILED"}`);
      }
    });

    this.listen(this.session.Page, "frameNavigated", (params) => {
      if (!this.active) return;
      if (!params.frame?.parentId) {
        this.navigationOccurred = true;
        this.newUrl = params.frame?.url;
      }
    });

    this.listen(this.session.DOM, "childNodeInserted", (params) => {
      if (!this.active) return;
      const attrs = params.node?.attributes || [];
      const isToast = attrs.some(
        (a: any) => typeof a === "string" && /toast|snackbar|notification|alert/i.test(a)
      );
      if (isToast && this.toastMessages.length < MAX_TOASTS) {
        this.toastMessages.push("Toast or banner detected");
      }
    });

    this.listen(this.session.Runtime, "consoleAPICalled", (params) => {
      if (!this.active) return;
      if ((params.type === "error" || params.type === "warning") && this.errors.length < MAX_ERRORS) {
        const text = (params.args || []).map((a: any) => a.value || a.description).join(" ");
        this.errors.push(`[${params.type}] ${text}`);
      }
    });
  }

  public async start(): Promise<void> {
    this.requests.clear();
    this.toastMessages = [];
    this.errors = [];
    this.navigationOccurred = false;
    this.newUrl = undefined;

    if (this.unsubs.length === 0) {
      this.setupListeners();
    }

    await this.session.Network.enable();
    await this.session.Page.enable();
    await this.session.DOM.enable();
    await this.session.Runtime.enable();

    this.active = true;
  }

  public async stop(): Promise<TelemetryReport> {
    this.active = false;

    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {}
    }
    this.unsubs.length = 0;

    const requestsClean = Array.from(this.requests.values()).map((r) => {
      const { _startTimeMonotonic, _responseHeadersMonotonic, ...publicReq } = r;
      return publicReq;
    });

    return {
      networkRequests: requestsClean,
      domMutations: this.toastMessages.length > 0 ? ["Toasts appeared"] : [],
      navigationOccurred: this.navigationOccurred,
      newUrl: this.newUrl,
      toastMessages: this.toastMessages,
      errors: this.errors,
    };
  }
}
