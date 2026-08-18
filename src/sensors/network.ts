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

export class TelemetryCapture {
  private session: CDP.Client;
  
  private requests = new Map<string, CapturedRequest>();
  private toastMessages: string[] = [];
  private errors: string[] = [];
  private navigationOccurred = false;
  private newUrl?: string;
  
  private active = false;

  // Store each CDP event listener reference so stop() can remove them.
  // Multiple TelemetryCapture instances per session must not accumulate listeners.
  private _onRequestWillBeSent: ((params: any) => void) | null = null;
  private _onResponseReceived: ((params: any) => void) | null = null;
  private _onLoadingFinished: ((params: any) => void) | null = null;
  private _onLoadingFailed: ((params: any) => void) | null = null;
  private _onFrameNavigated: ((params: any) => void) | null = null;
  private _onChildNodeInserted: ((params: any) => void) | null = null;
  private _onConsoleAPICalled: ((params: any) => void) | null = null;

  constructor(session: CDP.Client) {
    this.session = session;
    this.setupListeners();
  }

  private setupListeners() {
    this._onRequestWillBeSent = (params) => {
      if (!this.active) return;
      this.requests.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        isApi: params.request.url.includes('/api/') || params.request.headers?.['Accept']?.includes('application/json'),
        timestamp: params.wallTime ? params.wallTime * 1000 : Date.now(),
        _startTimeMonotonic: params.timestamp
      });
    };
    this.session.Network.requestWillBeSent(this._onRequestWillBeSent);

    this._onResponseReceived = (params) => {
      if (!this.active) return;
      const req = this.requests.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        if (params.response.mimeType?.includes('application/json')) {
          req.isApi = true;
        }

        // 1. Capture TLS/SSL Certificate Metadata
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
            certificateId: sec.certificateId
          };
        }

        // 2. Capture Network Timing Breakdown (DNS, TCP, SSL, Send, Wait)
        if (params.response.timing) {
          const t = params.response.timing;
          const dnsMs = (t.dnsEnd > 0 && t.dnsStart >= 0) ? Math.max(0, t.dnsEnd - t.dnsStart) : 0;
          const connectMs = (t.connectEnd > 0 && t.connectStart >= 0) ? Math.max(0, t.connectEnd - t.connectStart) : 0;
          const sslMs = (t.sslEnd > 0 && t.sslStart >= 0) ? Math.max(0, t.sslEnd - t.sslStart) : 0;
          const sendMs = (t.sendEnd > 0 && t.sendStart >= 0) ? Math.max(0, t.sendEnd - t.sendStart) : 0;
          const waitMs = (t.receiveHeadersStart > 0 && t.sendEnd >= 0) ? Math.max(0, t.receiveHeadersStart - t.sendEnd) : 0;

          req.timing = {
            dnsMs: Number(dnsMs.toFixed(3)),
            connectMs: Number(connectMs.toFixed(3)),
            sslMs: Number(sslMs.toFixed(3)),
            sendMs: Number(sendMs.toFixed(3)),
            waitMs: Number(waitMs.toFixed(3)),
          };

          if (t.requestTime && t.receiveHeadersStart > 0) {
            req._responseHeadersMonotonic = t.requestTime + (t.receiveHeadersStart / 1000);
          }
        }
      }
    };
    this.session.Network.responseReceived(this._onResponseReceived);

    this._onLoadingFinished = (params) => {
      if (!this.active) return;
      const req = this.requests.get(params.requestId);
      if (req) {
        const finishTimeMonotonic = params.timestamp;
        if (req._startTimeMonotonic && finishTimeMonotonic) {
          const totalMs = (finishTimeMonotonic - req._startTimeMonotonic) * 1000;
          if (!req.timing) req.timing = {};
          req.timing.totalMs = Number(Math.max(0, totalMs).toFixed(3));

          if (req._responseHeadersMonotonic) {
            const downloadMs = (finishTimeMonotonic - req._responseHeadersMonotonic) * 1000;
            req.timing.downloadMs = Number(Math.max(0, downloadMs).toFixed(3));
          } else {
            req.timing.downloadMs = 0;
          }
        }
      }
    };
    this.session.Network.loadingFinished(this._onLoadingFinished);

    this._onLoadingFailed = (params) => {
      if (!this.active) return;
      const req = this.requests.get(params.requestId);
      if (req) {
        req.failure = {
          errorText: params.errorText || "net::ERR_FAILED",
          canceled: params.canceled,
          blockedReason: params.blockedReason
        };
        this.errors.push(`[Network Error] ${req.url} failed: ${params.errorText || 'net::ERR_FAILED'}`);
      }
    };
    this.session.Network.loadingFailed(this._onLoadingFailed);

    this._onFrameNavigated = (params) => {
      if (!this.active) return;
      if (!params.frame.parentId) { // Main frame
        this.navigationOccurred = true;
        this.newUrl = params.frame.url;
      }
    };
    this.session.Page.frameNavigated(this._onFrameNavigated);

    this._onChildNodeInserted = (params) => {
      if (!this.active) return;
      const attrs = params.node.attributes || [];
      const isToast = attrs.some((a: any) => typeof a === 'string' && a.toLowerCase().match(/toast|snackbar|notification|alert/));
      if (isToast) {
         this.toastMessages.push("Toast or banner detected");
      }
    };
    this.session.DOM.childNodeInserted(this._onChildNodeInserted);

    this._onConsoleAPICalled = (params) => {
      if (!this.active) return;
      if (params.type === 'error' || params.type === 'warning') {
        const text = params.args.map((a: any) => a.value || a.description).join(' ');
        this.errors.push(`[${params.type}] ${text}`);
      }
    };
    this.session.Runtime.consoleAPICalled(this._onConsoleAPICalled);
  }

  public async start(): Promise<void> {
    this.requests.clear();
    this.toastMessages = [];
    this.errors = [];
    this.navigationOccurred = false;
    this.newUrl = undefined;
    
    await this.session.Network.enable();
    await this.session.Page.enable();
    await this.session.DOM.enable();
    await this.session.Runtime.enable();
    
    this.active = true;
  }

  public async stop(): Promise<TelemetryReport> {
    this.active = false;

    // Remove all listeners to prevent accumulation
    try {
      if (this._onRequestWillBeSent) (this.session.Network as any).removeListener('requestWillBeSent', this._onRequestWillBeSent);
      if (this._onResponseReceived) (this.session.Network as any).removeListener('responseReceived', this._onResponseReceived);
      if (this._onLoadingFinished) (this.session.Network as any).removeListener('loadingFinished', this._onLoadingFinished);
      if (this._onLoadingFailed) (this.session.Network as any).removeListener('loadingFailed', this._onLoadingFailed);
      if (this._onFrameNavigated) (this.session.Page as any).removeListener('frameNavigated', this._onFrameNavigated);
      if (this._onChildNodeInserted) (this.session.DOM as any).removeListener('childNodeInserted', this._onChildNodeInserted);
      if (this._onConsoleAPICalled) (this.session.Runtime as any).removeListener('consoleAPICalled', this._onConsoleAPICalled);
    } catch { /* ignore */ }
    this._onRequestWillBeSent = this._onResponseReceived = this._onLoadingFinished = this._onLoadingFailed =
      this._onFrameNavigated = this._onChildNodeInserted = this._onConsoleAPICalled = null;
    
    const requestsClean = Array.from(this.requests.values()).map(r => {
      const { _startTimeMonotonic, _responseHeadersMonotonic, ...publicReq } = r;
      return publicReq;
    });

    return {
      networkRequests: requestsClean,
      domMutations: this.toastMessages.length > 0 ? ["Toasts appeared"] : [], // simplified DOM mutations for now
      navigationOccurred: this.navigationOccurred,
      newUrl: this.newUrl,
      toastMessages: this.toastMessages,
      errors: this.errors
    };
  }
}

