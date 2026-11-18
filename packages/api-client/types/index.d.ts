export declare class CanvasError extends Error {
    constructor(
        message: string,
        options?: { code?: string; statusCode?: number; status?: number; cause?: unknown; retryable?: boolean; reason?: string; stoppedAt?: string | null; hint?: string }
    );
    /** Machine string: envelope `code` (e.g. 'WORKSPACE_NOT_ACTIVE') or 'CANVAS_ERROR'. */
    code: string;
    statusCode?: number;
    /** Alias of statusCode (historical cli field). */
    status?: number;
    cause?: unknown;
    retryable?: boolean;
    reason?: string;
    stoppedAt?: string | null;
    hint?: string;
}
export declare class AuthError extends CanvasError {
    constructor(message: string);
}
export declare class NotFoundError extends CanvasError {
    constructor(message: string);
}
export declare function isNetworkError(err: unknown): boolean;

export declare function unwrap<T = unknown>(body: unknown): T;

export declare function toFetchBody(data: unknown): {
    body?: BodyInit;
    duplex?: 'half';
    isJson?: boolean;
};

export interface RequestOptions {
    params?: Record<string, unknown>;
    data?: unknown;
    headers?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
    /** Return the whole success envelope for this request (`payload`, `count`, `totalCount`). */
    envelope?: boolean;
}

export interface CanvasApiClientOptions {
    baseUrl: string;
    apiBase?: string;
    getToken?: () => string | null;
    token?: string;
    timeout?: number;
    userAgent?: string;
    appName?: string;
    headers?: Record<string, string>;
    /**
     * Default true. When false, SUCCESS envelopes are returned whole
     * ({status, payload, count, ...}) instead of unwrapped to their payload —
     * for consumers mid-migration whose call sites still dig `.payload` out
     * themselves. Error envelopes throw either way.
     */
    unwrap?: boolean;
    fetch?: typeof fetch;
}

export interface AuthApi {
    login(creds: Record<string, unknown>): Promise<any>;
    logout(): Promise<any>;
    me(): Promise<any>;
    status(): Promise<any>;
    tokens: {
        list(): Promise<any>;
        create(data: unknown): Promise<any>;
        delete(id: string): Promise<any>;
        update(id: string, data: unknown): Promise<any>;
    };
    devices: {
        register(data: unknown): Promise<any>;
        list(): Promise<any>;
        update(id: string, data: unknown): Promise<any>;
        remove(id: string): Promise<any>;
    };
}

export interface WorkspacesApi {
    list(): Promise<any>;
    get(id: string): Promise<any>;
    create(data: unknown): Promise<any>;
    update(id: string, data: unknown): Promise<any>;
    delete(id: string): Promise<any>;
    start(id: string, options?: { passphrase?: string; withoutSecrets?: boolean }): Promise<any>;
    stop(id: string): Promise<any>;
    status(id: string): Promise<any>;
    stats(id: string): Promise<any>;
    tree(id: string): Promise<any>;
    trees(id: string): Promise<any>;
    removeTreePath(
        id: string,
        treeName: string,
        path: string,
        opts?: { recursive?: boolean; purge?: boolean; destroy?: boolean }
    ): Promise<any>;
    documents(id: string, params?: Record<string, unknown>): Promise<any>;
    insertDocuments(id: string, body: unknown): Promise<any>;
    uploadBlob(id: string, data: unknown): Promise<any>;
    dotfiles: {
        list(id: string, params?: Record<string, unknown>): Promise<any>;
        create(id: string, dotfiles: unknown, opts?: Record<string, unknown>): Promise<any>;
        update(id: string, docs: unknown, opts?: Record<string, unknown>): Promise<any>;
        delete(id: string, docIds: unknown): Promise<any>;
        status(id: string): Promise<any>;
        init(id: string): Promise<any>;
    };
    backends: {
        list(id: string, driver?: string | null): Promise<any>;
        get(id: string, driver: string, address: string): Promise<any>;
        add(id: string, driver: string, body: unknown): Promise<any>;
        update(id: string, driver: string, address: string, body: unknown): Promise<any>;
        remove(id: string, driver: string, address: string): Promise<any>;
        sync(id: string, driver: string, address: string): Promise<any>;
        usage(id: string, driver: string, address: string): Promise<any>;
        documents(id: string, driver: string, address: string, params?: Record<string, unknown>): Promise<any>;
        objects(id: string, driver: string, address: string, params?: Record<string, unknown>): Promise<any>;
        changes(id: string, driver: string, address: string, params?: Record<string, unknown>): Promise<any>;
        putObject(id: string, driver: string, address: string, key: string, data: unknown, opts?: { headers?: Record<string, string>; params?: Record<string, unknown> }): Promise<any>;
        deleteObject(id: string, driver: string, address: string, key: string, opts?: { ifMatch?: string; origin?: string }): Promise<any>;
        renameObject(id: string, driver: string, address: string, body: { from: string; to: string; ifMatch?: string; origin?: string }): Promise<any>;
    };
    sync: {
        mirrors(id: string): Promise<any>;
        reportMirror(id: string, deviceId: string, body: Record<string, unknown>): Promise<any>;
        forgetMirror(id: string, deviceId: string): Promise<any>;
        conflicts(id: string): Promise<any>;
        resolveConflict(id: string, docId: number | string, keep: 'hub' | 'incoming' | 'both'): Promise<any>;
    };
    hooks: {
        list(id: string): Promise<any>;
        get(id: string, hookPath: string): Promise<any>;
        set(id: string, hookPath: string, content: string): Promise<any>;
        delete(id: string, hookPath: string): Promise<any>;
        runs(id: string, params?: Record<string, unknown>): Promise<any>;
        explain(id: string, body: unknown): Promise<any>;
        backfill(id: string, body: unknown): Promise<any>;
        replay(id: string, runId: string): Promise<any>;
    };
}

export interface ContextsApi {
    list(): Promise<any>;
    get(id: string): Promise<any>;
    create(data: unknown): Promise<any>;
    update(id: string, data: unknown): Promise<any>;
    delete(id: string): Promise<any>;
    tree(id: string): Promise<any>;
    documents(id: string, params?: Record<string, unknown>): Promise<any>;
    insertDocuments(id: string, body: unknown): Promise<any>;
    uploadBlob(id: string, data: unknown): Promise<any>;
    dotfiles(id: string): Promise<any>;
    url(id: string): Promise<any>;
    setUrl(id: string, url: string): Promise<any>;
}

export interface AgentsApi {
    list(): Promise<any>;
    get(id: string): Promise<any>;
    status(id: string): Promise<any>;
    prompt(id: string, data: unknown): Promise<any>;
}

export interface RolesApi {
    list(): Promise<any>;
    get(id: string): Promise<any>;
}

export declare class CanvasApiClient {
    constructor(options: CanvasApiClientOptions);
    baseUrl: string;
    apiBase: string;
    getToken: () => string | null;
    timeout: number;
    auth: AuthApi;
    workspaces: WorkspacesApi;
    contexts: ContextsApi;
    agents: AgentsApi;
    roles: RolesApi;
    request(method: string, path: string, options?: RequestOptions): Promise<any>;
    get(path: string, options?: RequestOptions): Promise<any>;
    post(path: string, data?: unknown, options?: RequestOptions): Promise<any>;
    put(path: string, data?: unknown, options?: RequestOptions): Promise<any>;
    patch(path: string, data?: unknown, options?: RequestOptions): Promise<any>;
    delete(path: string, options?: RequestOptions): Promise<any>;
    ping(): Promise<any>;
}
