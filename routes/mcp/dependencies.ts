/**
 * MCP Server Dependencies
 * Contains tools, resources, and prompts registries
 * 
 * Import types from the Oxian framework for type safety and IDE support.
 */

import type {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  CallToolResult,
  ReadResourceParams,
  ReadResourceResult,
  GetPromptParams,
  GetPromptResult,
  MCPServerConfig,
} from "../../src/utils/mcp.ts";

// ============================================================================
// Weather Tool Implementation
// ============================================================================

const weatherTool: Tool = {
  name: "get_weather",
  description: "Get current weather information for any location worldwide. Returns temperature, conditions, wind speed, and humidity.",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name or coordinates (e.g., 'London', 'New York', '51.5074,-0.1278')",
      },
      units: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit (default: celsius)",
      },
    },
    required: ["location"],
  },
};

async function callWeatherTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const location = args.location as string;
  const units = (args.units as string) || "celsius";

  if (!location) {
    return {
      content: [{
        type: "text",
        text: "Error: location parameter is required",
      }],
      isError: true,
    };
  }

  try {
    // Using Open-Meteo API (free, no API key required)
    // First, geocode the location
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geoResponse = await fetch(geoUrl);
    const geoData = await geoResponse.json();

    if (!geoData.results || geoData.results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `Error: Location "${location}" not found`,
        }],
        isError: true,
      };
    }

    const { latitude, longitude, name, country } = geoData.results[0];

    // Get weather data
    const tempUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&temperature_unit=${tempUnit}&wind_speed_unit=kmh&precipitation_unit=mm`;
    
    const weatherResponse = await fetch(weatherUrl);
    const weatherData = await weatherResponse.json();

    const current = weatherData.current;
    
    // Map weather codes to descriptions
    const weatherDescriptions: Record<number, string> = {
      0: "Clear sky",
      1: "Mainly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Depositing rime fog",
      51: "Light drizzle",
      53: "Moderate drizzle",
      55: "Dense drizzle",
      61: "Slight rain",
      63: "Moderate rain",
      65: "Heavy rain",
      71: "Slight snow",
      73: "Moderate snow",
      75: "Heavy snow",
      77: "Snow grains",
      80: "Slight rain showers",
      81: "Moderate rain showers",
      82: "Violent rain showers",
      85: "Slight snow showers",
      86: "Heavy snow showers",
      95: "Thunderstorm",
      96: "Thunderstorm with slight hail",
      99: "Thunderstorm with heavy hail",
    };

    const conditions = weatherDescriptions[current.weather_code] || "Unknown";
    const unitSymbol = units === "fahrenheit" ? "°F" : "°C";

    const weatherReport = `Weather for ${name}, ${country}:
- Temperature: ${current.temperature_2m}${unitSymbol}
- Feels like: ${current.apparent_temperature}${unitSymbol}
- Conditions: ${conditions}
- Humidity: ${current.relative_humidity_2m}%
- Wind Speed: ${current.wind_speed_10m} km/h
- Precipitation: ${current.precipitation} mm`;

    return {
      content: [{
        type: "text",
        text: weatherReport,
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error fetching weather data: ${(error as Error).message}`,
      }],
      isError: true,
    };
  }
}

// ============================================================================
// Example Resource Implementation
// ============================================================================

const exampleResource: Resource = {
  uri: "weather://docs/api-info",
  name: "Weather API Documentation",
  description: "Information about the weather API and its capabilities",
  mimeType: "text/plain",
};

// ============================================================================
// Resource Templates - Dynamic Resources
// ============================================================================

const weatherByCityTemplate: ResourceTemplate = {
  uriTemplate: "weather://current/{city}",
  name: "Current Weather by City",
  description: "Get current weather data for any city using a template URI",
  mimeType: "application/json",
};

const docsByTopicTemplate: ResourceTemplate = {
  uriTemplate: "docs://{topic}",
  name: "Documentation by Topic",
  description: "Access documentation for various topics",
  mimeType: "text/markdown",
};

// ============================================================================
// Resource Reader (Static + Templates)
// ============================================================================

function readResource(params: ReadResourceParams): ReadResourceResult {
  const extendedParams = params as ReadResourceParams & Record<string, string>;
  
  // Static resource: API documentation
  if (params.uri === "weather://docs/api-info") {
    return {
      contents: [{
        uri: params.uri,
        mimeType: "text/plain",
        text: `Weather API Information

This MCP server provides weather data through the get_weather tool.

Data Source: Open-Meteo (https://open-meteo.com)
- Free and open-source weather API
- No API key required
- Global coverage
- Real-time weather data

Supported Parameters:
- location: City name or coordinates
- units: celsius (default) or fahrenheit

Example usage:
{
  "name": "get_weather",
  "arguments": {
    "location": "London",
    "units": "celsius"
  }
}`,
      }],
    };
  }

  // Template resource: weather://current/{city}
  if (extendedParams.city) {
    const city = extendedParams.city;
    return {
      contents: [{
        uri: params.uri,
        mimeType: "application/json",
        text: JSON.stringify({
          city: city,
          template: "weather://current/{city}",
          note: "This is a template resource. In a real implementation, you would fetch actual weather data here.",
          suggestion: `Use the get_weather tool with location="${city}" for real weather data`,
          example: {
            location: city,
            temperature: "15°C",
            conditions: "Partly cloudy",
            humidity: "65%",
          }
        }, null, 2),
      }],
    };
  }

  // Template resource: docs://{topic}
  if (extendedParams.topic) {
    const topic = extendedParams.topic;
    const docs: Record<string, string> = {
      "getting-started": `# Getting Started with MCP

MCP (Model Context Protocol) allows AI assistants to connect to external data sources and tools.

## Quick Start
1. Define your tools in dependencies.ts
2. Implement tool handlers
3. Start the server
4. Connect with MCP Inspector or Claude Desktop`,
      
      "resources": `# MCP Resources

Resources provide data that AI assistants can read.

## Resource Templates
Templates allow dynamic resources with parameters in the URI.

Example: \`docs://{topic}\` - Access docs for any topic`,
      
      "tools": `# MCP Tools

Tools are functions that AI assistants can call.

## Tool Definition
- name: Unique identifier
- description: What the tool does
- inputSchema: JSON Schema for parameters`,
    };

    const content = docs[topic] || `# ${topic}\n\nDocumentation for "${topic}" not found.\n\nAvailable topics:\n${Object.keys(docs).map(t => `- ${t}`).join('\n')}`;

    return {
      contents: [{
        uri: params.uri,
        mimeType: "text/markdown",
        text: content,
      }],
    };
  }

  throw new Error(`Resource not found: ${params.uri}`);
}

// ============================================================================
// Example Prompt Implementation
// ============================================================================

const weatherPrompt: Prompt = {
  name: "weather_report",
  description: "Generate a detailed weather report for a location",
  arguments: [{
    name: "location",
    description: "The location to get weather for",
    required: true,
  }, {
    name: "style",
    description: "Report style: formal, casual, or technical",
    required: false,
  }],
};

function getPrompt(params: GetPromptParams): GetPromptResult {
  if (params.name === "weather_report") {
    const location = params.arguments?.location as string || "London";
    const style = params.arguments?.style as string || "casual";

    const styleInstructions: Record<string, string> = {
      formal: "Write a formal, professional weather report suitable for a business context.",
      casual: "Write a friendly, conversational weather update.",
      technical: "Write a technical weather analysis with meteorological details.",
    };

    return {
      description: "A weather report prompt that adapts to different styles",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please provide a weather report for ${location}. ${styleInstructions[style] || styleInstructions.casual}

Use the get_weather tool to fetch current conditions, then format the information according to the requested style.`,
        },
      }],
    };
  }

  throw new Error(`Prompt not found: ${params.name}`);
}

// ============================================================================
// MCP Server State
// ============================================================================

export default function() {
  const tools: Tool[] = [weatherTool];
  
  const resources: Resource[] = [exampleResource];
  
  const resourceTemplates: ResourceTemplate[] = [
    weatherByCityTemplate,
    docsByTopicTemplate,
  ];
  
  const prompts: Prompt[] = [weatherPrompt];

  // Tool execution handlers
  const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {
    get_weather: callWeatherTool,
  };

  // Return MCP server configuration
  const mcpServer: MCPServerConfig = {
    info: {
      name: "oxian-mcp-weather",
      version: "1.0.0",
    },
    capabilities: {
      tools: {},
      resources: {
        subscribe: false,
        listChanged: false,
      },
      prompts: {},
    },
    tools,
    resources,
    resourceTemplates,
    prompts,
    toolHandlers,
    readResource,
    getPrompt,
  };

  return {
    mcpServer,
  };
}

