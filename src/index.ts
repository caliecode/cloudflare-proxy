/**
 * Cloudflare Workers Reverse Proxy with Cookie Handling
 *
 * This worker proxies requests to a backend API while maintaining cookies and handling CORS.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Determine if this is an API request that should be proxied
    if (url.pathname.startsWith('/api/')) {
      return await handleApiRequest(request, env, url);
    }

    // For non-API requests, return a simple response or redirect
    return new Response('This is a proxy worker. API requests should be sent to /api/...');
  },
} satisfies ExportedHandler<Env>;

/**
 * Handles API requests by proxying them to the backend
 */
async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  // Configure your backend URL here
  const backendUrl = 'https://your-app-name.fly.dev' + url.pathname + url.search;

  // Clone headers to a mutable object
  const headers = new Headers(request.headers);

  // Forward the request to your API with all headers and the body
  const modifiedRequest = new Request(backendUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
    redirect: 'follow'
  });

  // Forward the request to your API
  const response = await fetch(modifiedRequest);

  // Clone the response before we modify it
  const responseData = await response.arrayBuffer();

  // Create a new response with the data
  const newResponse = new Response(responseData, {
    status: response.status,
    statusText: response.statusText,
  });

  // Copy all headers from the original response
  response.headers.forEach((value, key) => {
    // Skip the Set-Cookie header as we'll handle that specially
    if (key.toLowerCase() !== 'set-cookie') {
      newResponse.headers.set(key, value);
    }
  });

  // Handle cookies specially
  const setCookieHeaders = response.headers.getAll('Set-Cookie');
  if (setCookieHeaders && setCookieHeaders.length > 0) {
    setCookieHeaders.forEach(cookie => {
      const modifiedCookie = modifyCookie(cookie, request.url);
      if (modifiedCookie) {
        newResponse.headers.append('Set-Cookie', modifiedCookie);
      }
    });
  }

  // Add CORS headers to allow cross-domain requests
  newResponse.headers.set('Access-Control-Allow-Origin', url.origin);
  newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return newResponse;
}

/**
 * Modifies cookies to ensure they work correctly across domains
 */
function modifyCookie(cookie: string, requestUrl: string): string | null {
  if (!cookie) return null;

  const url = new URL(requestUrl);
  const cookieParts = cookie.split(';').map(part => part.trim());
  const mainPart = cookieParts[0]; // This contains name=value

  // Create a new array for the modified cookie parts
  const newCookieParts = [mainPart];

  // Keep track if we've seen these attributes
  let hasDomain = false;
  let hasSameSite = false;
  let hasSecure = false;

  // Process all cookie attributes except the main part
  for (let i = 1; i < cookieParts.length; i++) {
    const part = cookieParts[i].toLowerCase();

    // Check for existing attributes
    if (part.startsWith('domain=')) {
      // Replace domain with the domain from the request URL
      newCookieParts.push(`Domain=${url.hostname}`);
      hasDomain = true;
    } else if (part.startsWith('samesite=')) {
      // Keep original SameSite or set to None for cross-domain cookies
      newCookieParts.push('SameSite=None');
      hasSameSite = true;
    } else if (part === 'secure') {
      newCookieParts.push('Secure');
      hasSecure = true;
    } else {
      // Keep all other attributes as they are
      newCookieParts.push(cookieParts[i]);
    }
  }

  // Add missing attributes if needed
  if (!hasDomain) {
    newCookieParts.push(`Domain=${url.hostname}`);
  }

  if (!hasSameSite) {
    newCookieParts.push('SameSite=None');
  }

  if (!hasSecure) {
    newCookieParts.push('Secure');
  }

  return newCookieParts.join('; ');
}
