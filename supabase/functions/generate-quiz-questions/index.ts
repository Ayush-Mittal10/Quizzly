
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Define QuizQuestion type internally instead of importing from src/types
interface QuizQuestion {
  id: string;
  text: string;
  type: "multiple-choice" | "single-choice";
  options: string[];
  correctAnswers: number[];
  points: number;
}

const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Check if OpenAI API key is configured
    if (!openaiApiKey) {
      console.error("OpenAI API key is not configured");
      return new Response(
        JSON.stringify({ error: "OpenAI API key is not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { topic, numQuestions, difficulty } = await req.json();

    if (!topic || !numQuestions) {
      return new Response(
        JSON.stringify({ error: "Topic and number of questions are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log(`Generating ${numQuestions} questions about "${topic}" at ${difficulty || "moderate"} difficulty`);

    // Construct system prompt for consistent question generation
    const systemPrompt = `You are an educational quiz question generator. Generate ${numQuestions} multiple-choice quiz questions about "${topic}" at ${difficulty || "moderate"} difficulty level.

For each question:
1. Create a clear, concise question text
2. Provide 4 possible answer options
3. Indicate which option(s) is correct (only one for single-choice questions)
4. Assign a point value (1-5 based on difficulty)

Format your response as a JSON array with this structure:
[
  {
    "text": "Question text here?",
    "type": "single-choice",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correctAnswers": [0], // Index of correct answer(s)
    "points": 2
  },
  // More questions...
]

Important guidelines:
- Keep questions focused and relevant to the topic
- Answers should be concise (under 10 words each)
- Include a mix of difficulty levels
- Questions should be factually correct
- No duplicate questions or answer options
- Each question must have exactly one correct answer`;

    console.log("Sending request to OpenAI API...");
    
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // Using a more cost-effective model
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Generate ${numQuestions} quiz questions about ${topic} at ${difficulty || "moderate"} difficulty.` },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    // Log response status and headers for debugging
    console.log(`OpenAI API response status: ${response.status}`);
    
    const data = await response.json();
    
    // Log the raw response for debugging
    console.log("OpenAI API response received:", JSON.stringify(data).slice(0, 200) + "...");
    
    // Check for API errors
    if (data.error) {
      console.error("OpenAI API error:", data.error);
      
      // Extract more specific error information
      const errorMessage = data.error.message || "Unknown OpenAI API error";
      const errorCode = data.error.code || "unknown";
      const errorType = data.error.type || "unknown";
      
      console.error(`Error details - Code: ${errorCode}, Type: ${errorType}, Message: ${errorMessage}`);
      
      return new Response(
        JSON.stringify({ 
          error: `OpenAI API error: ${errorMessage}`,
          code: errorCode,
          type: errorType
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error("Unexpected API response:", data);
      throw new Error("Invalid response from OpenAI API");
    }

    let generatedQuestions;
    try {
      const content = data.choices[0].message.content;
      console.log("Content received:", content.slice(0, 200) + "...");
      
      // Extract JSON part if the AI included extra text
      const jsonMatch = content.match(/\[\s*\{.*\}\s*\]/s);
      const jsonContent = jsonMatch ? jsonMatch[0] : content;
      
      try {
        generatedQuestions = JSON.parse(jsonContent);
        console.log(`Successfully parsed ${generatedQuestions.length} questions`);
      } catch (parseError) {
        console.error("JSON parsing error:", parseError);
        console.log("JSON content that failed to parse:", jsonContent);
        throw new Error("Failed to parse generated questions: " + parseError.message);
      }
      
      // Validate and format questions
      generatedQuestions = generatedQuestions.map((q: any, index: number) => ({
        id: `q-${Date.now()}-${index}`,
        text: q.text,
        type: q.type === "multiple-choice" ? "multiple-choice" : "single-choice",
        options: Array.isArray(q.options) && q.options.length > 0 ? q.options : ["Option 1", "Option 2", "Option 3", "Option 4"],
        correctAnswers: Array.isArray(q.correctAnswers) ? q.correctAnswers : [0],
        points: typeof q.points === "number" && q.points >= 1 && q.points <= 5 ? q.points : 1
      }));
    } catch (error) {
      console.error("Error processing generated questions:", error);
      throw new Error("Failed to process generated questions: " + error.message);
    }

    console.log(`Successfully generated and formatted ${generatedQuestions.length} questions`);
    
    return new Response(JSON.stringify({ questions: generatedQuestions }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error generating quiz questions:", error);
    return new Response(
      JSON.stringify({ 
        error: error.message || "Failed to generate questions",
        stack: error.stack
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
