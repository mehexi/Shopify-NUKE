const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const API_VERSION = "2025-10";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, url, { headers, data, attempts = 0 } = {}) {
  try {
    const resp = await axios({ method, url, headers, data, timeout: 120000, validateStatus: () => true });
    if ((resp.status === 429 || (resp.status >= 500 && resp.status < 600)) && attempts < 6) {
      const ra = resp.headers["retry-after"] ? parseInt(resp.headers["retry-after"], 10) * 1000 : Math.min(1000 * 2 ** attempts, 30000);
      console.warn(`[${resp.status}] ${method.toUpperCase()} ${url} → retry in ${ra}ms`);
      await sleep(ra);
      return request(method, url, { headers, data, attempts: attempts + 1 });
    }
    return resp;
  } catch (err) {
    if (attempts < 6) {
      const backoff = Math.min(1000 * 2 ** attempts, 30000);
      console.warn(`[ERR] ${method.toUpperCase()} ${url} → retry in ${backoff}ms: ${err.message}`);
      await sleep(backoff);
      return request(method, url, { headers, data, attempts: attempts + 1 });
    }
    throw err;
  }
}

function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const p of parts) {
    const m = p.match(/<([^>]+)>;\s*rel="next"/);
    if (m) {
      const url = new URL(m[1]);
      return url.searchParams.get("page_info");
    }
  }
  return null;
}

async function listAll({ label, path, rootKey, limit = 250, base, headers }) {
  const all = [];
  let page_info = null;
  do {
    const url = page_info
      ? `${base}/${path}?limit=${limit}&page_info=${encodeURIComponent(page_info)}`
      : `${base}/${path}?limit=${limit}`;
    const resp = await request("get", url, { headers });
    if (resp.status !== 200) {
      console.warn(`List ${label}: HTTP ${resp.status}`, resp.data);
      break;
    }
    const items = resp.data[rootKey] || [];
    all.push(...items);
    page_info = parseNextPageInfo(resp.headers["link"]);
  } while (page_info);
  console.log(`Found ${all.length} ${label}`);
  return all;
}

async function listThemes(base, headers) {
  const resp = await request("get", `${base}/themes.json`, { headers });
  if (resp.status !== 200) {
    console.warn(`List themes: HTTP ${resp.status}`, resp.data);
    return [];
  }
  return resp.data.themes || [];
}

async function deleteItem({ label, path, base, headers }) {
  const resp = await request("delete", `${base}/${path}`, { headers });
  if (resp.status === 200 || resp.status === 204) {
    console.log(`[OK ] Deleted ${label}`);
  } else {
    console.warn(`[ERR] Delete ${label}: HTTP ${resp.status}`, resp.data);
  }
  await sleep(250);
  return resp;
}

async function createTemporaryTheme(base, headers) {
  console.log("Creating temporary theme to allow main theme deletion...");
  const data = {
    theme: {
      name: "Temporary Theme for Deletion",
    },
  };
  const createResp = await request("post", `${base}/themes.json`, { headers, data });
  if (createResp.status !== 201) {
    throw new Error(`Failed to create temporary theme: HTTP ${createResp.status} - ${JSON.stringify(createResp.data)}`);
  }
  const theme = createResp.data.theme;
  console.log(`[OK ] Created temporary theme #${theme.id} (${theme.name})`);

  const assetData = {
    asset: {
      key: "layout/theme.liquid",
      value: `<!DOCTYPE html>
<html>
<head>
  <title>Temporary Theme</title>
  {{ content_for_header }}
</head>
<body>
  {{ content_for_layout }}
</body>
</html>`,
    },
  };
  const assetResp = await request("put", `${base}/themes/${theme.id}/assets.json`, { headers, data: assetData });
  if (assetResp.status !== 200) {
    throw new Error(`Failed to add layout/theme.liquid to theme #${theme.id}: HTTP ${assetResp.status} - ${JSON.stringify(assetResp.data)}`);
  }
  console.log(`[OK ] Added layout/theme.liquid to theme #${theme.id}`);

  const updateData = {
    theme: {
      id: theme.id,
      role: "main",
    },
  };
  const updateResp = await request("put", `${base}/themes/${theme.id}.json`, { headers, data: updateData });
  if (updateResp.status !== 200) {
    throw new Error(`Failed to set theme #${theme.id} as main: HTTP ${updateResp.status} - ${JSON.stringify(updateResp.data)}`);
  }
  console.log(`[OK ] Set temporary theme #${theme.id} (${theme.name}) as main`);
  return theme;
}

async function nukeShopify(shop, accessToken) {
  if (!shop || !accessToken) {
    throw new Error("Missing shop or accessToken");
  }

  const base = `https://${shop}/admin/api/${API_VERSION}`;
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  console.log("\n=== Shopify Nuke API ===");
  console.log("WARNING: This will delete ALL data, including ALL themes!");
  console.log(`Shop: ${shop}`);
  console.log(`API Version: ${API_VERSION}`);
  console.log("Mode: LIVE (DESTRUCTIVE) — ALL data, including ALL themes, will be deleted!");

  let tempTheme;
  try {
    tempTheme = await createTemporaryTheme(base, headers);
  } catch (err) {
    throw new Error(`Failed to create temporary theme: ${err.message}`);
  }

  const operations = [
    { label: "products", path: "products.json", rootKey: "products" },
    { label: "custom collections", path: "custom_collections.json", rootKey: "custom_collections" },
    { label: "smart collections", path: "smart_collections.json", rootKey: "smart_collections" },
    { label: "pages", path: "pages.json", rootKey: "pages" },
    { label: "blogs", path: "blogs.json", rootKey: "blogs" },
    { label: "redirects", path: "redirects.json", rootKey: "redirects" },
    { label: "script tags", path: "script_tags.json", rootKey: "script_tags" },
    { label: "files", path: "files.json", rootKey: "files" },
    { label: "customers", path: "customers.json", rootKey: "customers" },
  ];

  for (const op of operations) {
    const items = await listAll({ ...op, base, headers });
    for (const item of items) {
      await deleteItem({ label: `${op.label} #${item.id} (${item.title || item.email || item.path || item.filename || item.alt || item.url || ""})`, path: `${op.path.split(".")[0]}/${item.id}.json`, base, headers });
    }
  }

  const themes = await listThemes(base, headers);
  for (const t of themes) {
    await deleteItem({ label: `theme #${t.id} (${t.name})`, path: `themes/${t.id}.json`, base, headers });
  }

  return { message: "Destructive run complete. ALL data, including ALL themes, has been deleted. Revoke the Admin API token immediately in Shopify Admin." };
}

app.post("/nuke", async (req, res) => {
  const { shop, accessToken } = req.body;

  try {
    const result = await nukeShopify(shop, accessToken);
    res.status(200).json(result);
  } catch (err) {
    console.error("Fatal error:", err?.response?.data || err);
    res.status(500).json({
      error: err.message,
      details: err?.response?.data || "Unknown error",
      advice: "Ensure the API token has 'write_themes' scope. If theme creation failed, manually install a new theme in Shopify Admin and set it as main before retrying.",
    });
  }
});

// Serve raw HTML at the root route
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Shopify Nuke</title>
      <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
      <div class="bg-white p-6 rounded-lg shadow-lg w-full max-w-md">
        <h1 class="text-2xl font-bold text-center text-red-600 mb-4">Shopify Nuke</h1>
        <p class="text-sm text-gray-600 mb-4">
          <strong>WARNING:</strong> This tool will <strong>permanently delete ALL data</strong> in your Shopify store, including ALL themes, which may break the front-end. Make a full backup before proceeding. Revoke the API token immediately after use.
        </p>
        <div class="space-y-4">
          <div>
            <label for="shop" class="block text-sm font-medium text-gray-700">Shopify Store URL</label>
            <input
              type="text"
              id="shop"
              placeholder="your-store.myshopify.com"
              class="mt-1 block w-full p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
            >
          </div>
          <div>
            <label for="accessToken" class="block text-sm font-medium text-gray-700">Admin API Token</label>
            <input
              type="text"
              id="accessToken"
              placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              class="mt-1 block w-full p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
            >
          </div>
          <button
            id="nukeButton"
            class="w-full bg-red-600 text-white p-2 rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            disabled
          >
            Nuke Store
          </button>
        </div>
        <div id="status" class="mt-4 text-sm text-gray-600"></div>
      </div>

      <script>
        const shopInput = document.getElementById("shop");
        const accessTokenInput = document.getElementById("accessToken");
        const nukeButton = document.getElementById("nukeButton");
        const statusDiv = document.getElementById("status");

        function updateButtonState() {
          nukeButton.disabled = !shopInput.value.trim() || !accessTokenInput.value.trim();
        }

        shopInput.addEventListener("input", updateButtonState);
        accessTokenInput.addEventListener("input", updateButtonState);

        nukeButton.addEventListener("click", async () => {
          const shop = shopInput.value.trim();
          const accessToken = accessTokenInput.value.trim();

          nukeButton.disabled = true;
          statusDiv.textContent = "Initiating destructive operation... Please wait.";
          statusDiv.className = "mt-4 text-sm text-blue-600";

          try {
            const response = await fetch("/nuke", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ shop, accessToken }),
            });

            const result = await response.json();

            if (response.ok) {
              statusDiv.textContent = result.message;
              statusDiv.className = "mt-4 text-sm text-green-600";
            } else {
              statusDiv.textContent = \`Error: \${result.error}\\nDetails: \${JSON.stringify(result.details)}\\nAdvice: \${result.advice}\`;
              statusDiv.className = "mt-4 text-sm text-red-600";
            }
          } catch (err) {
            statusDiv.textContent = \`Network error: \${err.message}\`;
            statusDiv.className = "mt-4 text-sm text-red-600";
          } finally {
            nukeButton.disabled = false;
          }
        });
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopify Nuke API with raw HTML frontend running on port ${PORT}`);
});
