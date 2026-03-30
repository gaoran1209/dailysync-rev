export interface GarminExportedToken {
    oauth1: Record<string, any>;
    oauth2: Record<string, any>;
}

export interface GarminClientType {
    client: {
        oauth1Token?: Record<string, any>;
        oauth2Token?: Record<string, any>;
        fetchOauthConsumer?: () => Promise<void>;
        getOauth1Token?: (ticket: string) => Promise<Record<string, any>>;
        exchange?: (oauth1: Record<string, any>) => Promise<void>;
    };
    exportToken: () => GarminExportedToken;
    loadToken: (oauth1: Record<string, any>, oauth2: Record<string, any>) => void;
    login: (username?: string, password?: string) => Promise<GarminClientType>;
    getUserProfile: () => Promise<Record<string, any>>;
    getActivities: (start?: number, limit?: number) => Promise<Record<string, any>[]>;
    getActivity: (activity: Record<string, any>) => Promise<Record<string, any>>;
    downloadOriginalActivityData: (activity: Record<string, any>, dir: string, type?: string) => Promise<void>;
    uploadActivity: (path: string, format?: string) => Promise<Record<string, any>>;
}

export type GarminLoginMode = 'legacy_mfa' | 'token_only';

export interface GarminLoginOptions {
    username?: string;
    password?: string;
    sessionUser?: string;
    loginMode?: GarminLoginMode;
    authStateKey?: string;
}

export interface GarminSyncOptions {
    cn?: GarminLoginOptions;
    global?: GarminLoginOptions;
}

export interface GarminSyncResult {
    status: 'ok' | 'no_new_data';
    uploadedCount: number;
    message: string;
    latestSourceStartTime?: string;
    latestTargetStartTime?: string;
}
