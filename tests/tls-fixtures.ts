import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Generates a throwaway CA + SAN server cert + client cert at runtime via the
// system `openssl`. Tests trust this CA explicitly (pass `ca` to https.request);
// nothing ever disables certificate verification.

export interface TlsFixtures {
  dir: string;
  caCertPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  caCert: Buffer;
  clientCert: Buffer;
  clientKey: Buffer;
  cleanup: () => void;
}

export function generateTlsFixtures(): TlsFixtures {
  const dir = mkdtempSync(join(tmpdir(), "tls-fixtures-"));
  const p = (f: string): string => join(dir, f);
  const ossl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"] });
  };

  // CA
  ossl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", p("ca.key"), "-out", p("ca.crt"), "-days", "2", "-subj", "/CN=Test CA"]);

  // Server cert with SAN for 127.0.0.1 / localhost, signed by the CA
  ossl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", p("server.key"), "-out", p("server.csr"), "-subj", "/CN=localhost"]);
  writeFileSync(p("server.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
  ossl(["x509", "-req", "-in", p("server.csr"), "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAcreateserial", "-out", p("server.crt"), "-days", "2", "-extfile", p("server.ext")]);

  // Client cert signed by the same CA (for mTLS)
  ossl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", p("client.key"), "-out", p("client.csr"), "-subj", "/CN=test-client"]);
  ossl(["x509", "-req", "-in", p("client.csr"), "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAserial", p("ca.srl"), "-out", p("client.crt"), "-days", "2"]);

  return {
    dir,
    caCertPath: p("ca.crt"),
    serverCertPath: p("server.crt"),
    serverKeyPath: p("server.key"),
    clientCertPath: p("client.crt"),
    clientKeyPath: p("client.key"),
    caCert: readFileSync(p("ca.crt")),
    clientCert: readFileSync(p("client.crt")),
    clientKey: readFileSync(p("client.key")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
