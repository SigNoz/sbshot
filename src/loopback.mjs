/**
 * The names a request to this machine's loopback interface carries in its
 * `Host`. A page served from anywhere else that reaches a local port through
 * DNS rebinding carries its own name instead, which is how both local
 * servers (the viewer and a build's static server) tell it apart.
 */
export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The hostname of a request's `Host` header, lowercase, without the port. */
export const hostnameOf = (request) =>
	(request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
