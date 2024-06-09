"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useTheDomain } from "./useTheDomain";
import { Peer } from "../../core/synthient-chain/db/entities";
import {
  LLMModelName,
  LLMEngineLogEntry,
  availableModels,
} from "../../core/synthient-chain/llm/types";
import PacketCards from "./packetCards";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@radix-ui/react-popover";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

function DashboardContent({
  identityPassword,
  overwriteIdentity,
}: {
  identityPassword: string;
  overwriteIdentity: boolean;
}) {
  const {
    peers,
    packets,
    llmEngineLog,
    llmWorkerStates,
    mySynthientId,
    scaleLLMWorkers,
  } = useTheDomain(identityPassword, overwriteIdentity);

  const [open, setOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<LLMModelName | "">("");
  const [numWorkers, setNumWorkers] = useState(1);

  const handleScale = () => {
    if (selectedModel) {
      console.log(`Scaling ${numWorkers} workers for model ${selectedModel}`);
      if (selectedModel) scaleLLMWorkers(selectedModel, numWorkers);
    }
  };

  const scaleWorkers = (modelName: LLMModelName, numWorkers: number) => {};

  return (
    <div className="p-8 overflow-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex flex-col  mb-8">
          <h1 className="text-4xl font-bold mb-2">Started A Rakis</h1>
          <h2 className="text-sm font-bold">ID: {mySynthientId}</h2>
        </div>

        <div className="flex items-center space-x-4">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-[300px] justify-between"
              >
                {selectedModel || "Select model..."}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0 z-50">
              <Command>
                <CommandInput placeholder="Search model..." />
                <CommandList>
                  <CommandEmpty>No model found.</CommandEmpty>
                  <CommandGroup>
                    {availableModels.map((model) => (
                      <CommandItem
                        key={model}
                        value={model}
                        onSelect={(currentValue) => {
                          setSelectedModel(
                            currentValue === selectedModel
                              ? ""
                              : (currentValue as LLMModelName)
                          );
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedModel === model
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        {model}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <input
            type="number"
            min={1}
            value={numWorkers}
            onChange={(e) => setNumWorkers(parseInt(e.target.value))}
            className="w-20 px-2 py-1 border rounded-md"
          />
          <Button onClick={handleScale}>Scale Workers</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-[calc(100vh-10rem)] overflow-auto">
        <div className="lg:col-span-1">
          <LLMWorkerStatesAndLogs
            llmWorkerStates={llmWorkerStates}
            llmEngineLog={llmEngineLog}
          />
        </div>
        <div className="lg:col-span-1">
          {packets && (
            <div className="bg-white rounded-lg shadow-lg p-6 lg:h-[50vh]">
              <PacketCards packets={packets.packets} total={packets.total} />
            </div>
          )}
        </div>
        <div className="lg:col-span-1">
          {peers && <PeerTable peers={peers} />}
        </div>
      </div>
    </div>
  );
}

export function LLMWorkerStatesAndLogs({
  llmWorkerStates,
  llmEngineLog,
}: {
  llmWorkerStates: {
    [workerId: string]: { modelName: LLMModelName; state: string };
  };
  llmEngineLog: LLMEngineLogEntry[];
}) {
  function getLogRef(entry: LLMEngineLogEntry) {
    if (entry.type === "engine_loading" || entry.type === "engine_loaded")
      return entry.modelName;

    if (entry.type === "engine_loading_error") return entry.modelName;

    if (
      entry.type === "engine_inference_start" ||
      entry.type === "engine_inference_error" ||
      entry.type === "engine_inference_streaming_result"
    )
      return entry.inferenceId;

    return "-";
  }

  function getLogData(entry: LLMEngineLogEntry) {
    if (entry.type === "engine_loading" || entry.type === "engine_loaded")
      return "-";

    if (entry.type === "engine_loading_error") return entry.error;

    if (entry.type === "engine_inference_start")
      return JSON.stringify(entry.params);

    if (entry.type === "engine_inference_error") return entry.error;

    if (entry.type === "engine_inference_streaming_result")
      return `Tokens: ${entry.tokenCount} - ${entry.result}`;

    return "-";
  }

  return (
    <Card className="lg:h-[50vh] overflow-y-auto bg-blue-50">
      <CardHeader>
        <CardTitle className="text-xl">Inference Engine</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col h-full">
        <div className="mb-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-sm">Worker Id</TableHead>
                <TableHead className="text-sm">Model</TableHead>
                <TableHead className="text-sm text-right">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(llmWorkerStates).map(
                ([workerId, { modelName, state }]) => (
                  <TableRow key={workerId}>
                    <TableCell className="text-xs">{workerId}</TableCell>
                    <TableCell className="text-sm">{modelName}</TableCell>
                    <TableCell className="text-sm text-right">
                      {state}
                    </TableCell>
                  </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </div>
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-sm">Worker</TableHead>
                <TableHead className="text-sm">Type</TableHead>
                <TableHead className="text-sm">Ref</TableHead>
                <TableHead className="text-sm">Data</TableHead>
                <TableHead className="text-sm text-right">At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {llmEngineLog
                .sort((a, b) => b.at!.getTime() - a.at!.getTime())
                .map((entry, index) => (
                  <TableRow key={entry.workerId + entry.at!.toISOString()}>
                    <TableCell className="text-xs">{entry.workerId}</TableCell>
                    <TableCell className="text-xs">
                      {entry.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className="text-xs">
                      {getLogRef(entry)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {getLogData(entry)}
                    </TableCell>
                    <TableCell className="text-xs text-right">
                      {entry.at!.toLocaleString([], {
                        year: "2-digit",
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function PeerTable({ peers }: { peers: Peer[] }) {
  return (
    <Card className="lg:h-[50vh] overflow-y-auto bg-green-50">
      <CardHeader>
        <CardTitle className="text-xl">Peers (last 24h)</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px] text-sm">Id</TableHead>
              <TableHead className="text-sm">Seen</TableHead>
              <TableHead className="text-sm text-right">Last Seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {peers
              .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
              .map((peer) => (
                <TableRow key={peer.synthientId}>
                  <TableCell className="text-xs font-medium">
                    {peer.synthientId.slice(0, 10)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {peer.seenOn.join(", ")}
                    <span className="ml-1 text-gray-400 text-[10px]">
                      ({peer.seenOn.length})
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-right">
                    {peer.lastSeen.toLocaleString([], {
                      year: "2-digit",
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="text-sm" colSpan={2}>
                Total
              </TableCell>
              <TableCell className="text-sm text-right">
                {peers.length}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const [password, setPassword] = useState("");
  const [overwriteIdentity, setOverwriteIdentity] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const handlePasswordSubmit = () => {
    setIsAuthenticated(true);
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-96">
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
          </CardHeader>
          <CardContent>
            <input
              type="password"
              placeholder="Enter password"
              value={password}
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  handlePasswordSubmit();
                }
              }}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 mt-2 border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
            <div className="mt-4">
              <Checkbox
                checked={overwriteIdentity}
                onCheckedChange={(checked) => setOverwriteIdentity(!!checked)}
              >
                Overwrite existing identity
              </Checkbox>
            </div>
          </CardContent>
          <CardFooter>
            <button
              onClick={handlePasswordSubmit}
              className="px-4 py-2 font-bold text-white bg-blue-500 rounded-full hover:bg-blue-700"
            >
              Submit
            </button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <DashboardContent
      identityPassword={password}
      overwriteIdentity={overwriteIdentity}
    />
  );
}
