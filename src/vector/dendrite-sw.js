// -*- coding: utf-8 -*-
// Copyright 2020 The Matrix.org Foundation C.I.C.
// Copyright 2020 New Vector Ltd
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const bundle_path = self.location.href.replace("/dendrite_sw.js", "")

const version = "0.0.1"

self.importScripts(`${bundle_path}/wasm_exec.js`,
                   `${bundle_path}/go_http_bridge.js`,
                   `${bundle_path}/sqlite_bridge.js`)

self.addEventListener('install', function(event) {
    console.log(`dendrite-sw.js: v${version} SW install`)
    // Tell the browser to kill old sw's running in other tabs and replace them with this one
    // This may cause spontaneous logouts.
    self.skipWaiting();
})

self.addEventListener('activate', function(event) {
    console.log(`dendrite-sw.js: v${version} SW activate`)
    global.process = {
        pid: 1,
        env: {
            DEBUG: "*",
        }
    };
    global.fs.stat = function(path, cb) {
        cb({
            code: "EINVAL",
        });
    }

    const config = {
        locateFile: filename => `${bundle_path}/../../sql-wasm.wasm`
    }

    event.waitUntil(
        sqlite_bridge.init(config).then(()=>{
            console.log(`dendrite-sw.js: v${version} starting dendrite.wasm...`)
            const go = new Go()
            WebAssembly.instantiateStreaming(fetch(`${bundle_path}/../../dendrite.wasm`), go.importObject).then((result) => {
                go.run(result.instance)
                // make fetch calls go through this sw - notably if a page registers a sw, it does NOT go through any sw by default
                // unless you refresh or call this function.
                console.log(`dendrite-sw.js: v${version} claiming open browser tabs`)
                self.clients.claim()
            });
        })
    )
})

async function sendRequestToGo(event) {
    if (!global._go_js_server || !global._go_js_server.fetch) {
        console.log(`dendrite-sw.js: v${version} no fetch listener present for ${event.request.url}`);
        return
    }
    console.log(`dendrite-sw.js: v${version} forwarding ${event.request.url} to Go`);
    const req = event.request
    let reqHeaders = ''
    if (req.headers) {
        for (const header of req.headers) {
            // FIXME: is this a safe header encoding?
            reqHeaders += `${header[0]}: ${header[1]}\n`
        }
    }
    let jj = null;
    if (req.method === "POST" || req.method === "PUT") {
        jj = await req.json();
        jj = JSON.stringify(jj);
        reqHeaders += `Content-Length: ${new Blob([jj]).size}`; // include utf-8 chars properly
    }

    if (reqHeaders.length > 0) {
        reqHeaders = `\r\n${reqHeaders}`
    }

    // Replace the timeout value for /sync calls to be 20s not 30s because Firefox
    // will aggressively cull service workers after a 30s idle period. Chrome doesn't.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=1378587
    const fullurl = req.url.replace("timeout=30000", "timeout=20000");
    
    const reqString = `${req.method} ${fullurl} HTTP/1.0${reqHeaders}\r\n\r\n${jj ? jj : ''}`

    const res = await global._go_js_server.fetch(reqString)
    if (res.error) {
        console.error(`dendrite-sw.js: v${version} Error for request: ${event.request.url} => ${res.error}`)
        return
    }
    const respString = res.result;

    const m = respString.match(/^(HTTP\/1.[01]) ((.*?) (.*?))(\r\n([^]*?)?(\r\n\r\n([^]*?)))?$/)
    if (!m) {
        console.warn("couldn't parse resp", respString);
        return;
    }
    const response = {
        "proto": m[1],
        "status": m[2],
        "statusCode": parseInt(m[3]),
        "headers": m[6],
        "body": m[8],
    }

    const respHeaders = new Headers()
    const headerLines = response.headers.split('\r\n')
    for (const headerLine of headerLines) {
        // FIXME: is this safe header parsing? Do we need to worry about line-wrapping?
        const match = headerLine.match(/^(.+?): *(.*?)$/)
        if (match) {
            respHeaders.append(match[1], match[2])
        }
        else {
            console.log("couldn't parse headerLine ", headerLine)
        }
    }

    return new Response(response.body, {
        status: response.statusCode,
        headers: respHeaders,
    })
}


self.addEventListener('fetch', function(event) {
    event.respondWith((async () => {
        // If this is a page refresh for the current page, then shunt in the new sw
        // https://github.com/w3c/ServiceWorker/issues/1238
        if (event.request.mode === "navigate" && event.request.method === "GET" && registration.waiting && (await clients.matchAll()).length < 2) {
            console.log("Forcing new sw.js into page")
            registration.waiting.postMessage('skipWaiting');
            return new Response("", {headers: {"Refresh": "0"}});
        }

        if (event.request.url.match(/\/_matrix\/client/)) {
            return await sendRequestToGo(event);
        }
        else {
            return fetch(event.request);
        }
    })());
})
