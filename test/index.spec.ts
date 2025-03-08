// test/index.spec.ts
import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Mock the global fetch function
const originalFetch = globalThis.fetch;
let mockFetchResponse: Response;
let mockFetchCall: { url: string; options: RequestInit } | null = null;

beforeEach(() => {
	mockFetchCall = null;

	globalThis.fetch = vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
		let urlString;
		let capturedOptions = { ...options };

		if (url instanceof Request) {
			urlString = url.url;
			capturedOptions = {
				...capturedOptions,
				method: url.method,
				headers: url.headers,
				body: url.body
			};
		} else {
			urlString = url.toString();
		}

		mockFetchCall = { url: urlString, options: capturedOptions };

		return mockFetchResponse || new Response('Mock backend response', {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Set-Cookie': 'auth_token=abc123; Path=/; Domain=laclipasa-backend.fly.dev; SameSite=Lax; Secure'
			}
		});
	});

	mockFetchResponse = new Response('Mock backend response', {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			'Set-Cookie': 'auth_token=abc123; Path=/; Domain=laclipasa-backend.fly.dev; SameSite=Lax; Secure'
		}
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('Reverse Proxy Worker', () => {
	it('responds with default message for non-API routes (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"This is a proxy worker. API requests should be sent to /fly-api/..."`);
	});

	it('responds with default message for non-API routes (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"This is a proxy worker. API requests should be sent to /fly-api/..."`);
	});

	it('proxies requests to API routes', async () => {
		const request = new IncomingRequest('http://example.com/fly-api/users');
		const ctx = createExecutionContext();

		await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Check that fetch was called with the expected URL
		expect(mockFetchCall).not.toBeNull();
		expect(mockFetchCall?.url).toBe('https://laclipasa-backend.fly.dev/users');
	});

	it('forwards request method, headers and body', async () => {
		const headers = new Headers({
			'Content-Type': 'application/json',
			'Authorization': 'Bearer token123'
		});

		const request = new IncomingRequest('http://example.com/fly-api/data', {
			method: 'POST',
			headers,
			body: JSON.stringify({ test: true })
		});

		const ctx = createExecutionContext();
		await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		// Check that the fetch call included the correct method, headers, and body
		expect(mockFetchCall?.options.method).toBe('POST');
		expect(mockFetchCall?.options.headers).toBeDefined();

		const fetchHeaders = mockFetchCall?.options.headers as Headers;
		expect(fetchHeaders.get('Content-Type')).toBe('application/json');
		expect(fetchHeaders.get('Authorization')).toBe('Bearer token123');

		// Can't directly check body content as it's a stream, but we can check it exists
		expect(mockFetchCall?.options.body).toBeDefined();
	});

	it('properly modifies cookies in the response', async () => {
		// Create a response with a cookie
		mockFetchResponse = new Response('Response with cookie', {
			headers: {
				'Set-Cookie': 'auth_token=abc123; Path=/; Domain=laclipasa-backend.fly.dev; SameSite=Lax'
			}
		});

		const request = new IncomingRequest('http://example.com/fly-api/login');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Get the Set-Cookie header from the response
		const setCookieHeader = response.headers.get('Set-Cookie');

		// Check that the cookie was modified correctly
		expect(setCookieHeader).toBeDefined();
		expect(setCookieHeader).toContain('Domain=example.com');
		expect(setCookieHeader).toContain('SameSite=None');
		expect(setCookieHeader).toContain('Secure');
	});

	it('handles multiple cookies correctly', async () => {
		// Create a mock response with multiple cookies
		const mockHeaders = new Headers();
		mockHeaders.append('Set-Cookie', 'auth_token=abc123; Path=/; Domain=laclipasa-backend.fly.dev');
		mockHeaders.append('Set-Cookie', 'session=xyz789; Path=/; Domain=laclipasa-backend.fly.dev');

		mockFetchResponse = new Response('Response with multiple cookies', {
			headers: mockHeaders
		});

		const request = new IncomingRequest('http://example.com/fly-api/login');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Get all Set-Cookie headers
		const setCookieHeaders = response.headers.getAll('Set-Cookie');

		// Check that both cookies were modified correctly
		expect(setCookieHeaders.length).toBe(2);
		expect(setCookieHeaders[0]).toContain('auth_token=abc123');
		expect(setCookieHeaders[0]).toContain('Domain=example.com');
		expect(setCookieHeaders[1]).toContain('session=xyz789');
		expect(setCookieHeaders[1]).toContain('Domain=example.com');
	});

	it('adds CORS headers to the response', async () => {
		const request = new IncomingRequest('http://example.com/fly-api/data');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Check CORS headers
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
		expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
	});

	it('handles OPTIONS requests for CORS preflight', async () => {
		const request = new IncomingRequest('http://example.com/fly-api/data', {
			method: 'OPTIONS'
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// For OPTIONS requests, we should check that it handles preflight correctly
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
	});
});
