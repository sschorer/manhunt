using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "do-storage", disk = (path = "/data", writable = true)),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  compatibilityDate = "2026-09-01",
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
  ],
  durableObjectNamespaces = [
    (className = "Game", uniqueKey = "manhunt-spike-game", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
  bindings = [
    (name = "GAME", durableObjectNamespace = "Game"),
  ],
);
