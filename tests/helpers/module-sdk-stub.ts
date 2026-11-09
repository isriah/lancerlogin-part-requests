// The part of @lancerlogin/module-sdk/api that src/api.ts uses at run time. Core provides the real SDK in a composed build.
export function defineApiModule<T>(contribution: T): T { return contribution; }
