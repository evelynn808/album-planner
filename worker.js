// Cloudflare Worker - Backend for Album Planner
// Deploy this at workers.cloudflare.com

export default {
  async fetch(request, env) {
    // Handle CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);

    // Route: Check usage limit
    if (url.pathname === '/api/check-usage' && request.method === 'POST') {
      return await handleCheckUsage(request, env);
    }

    // Route: Send chat message
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return await handleChat(request, env);
    }

    // Route: Create Stripe checkout session
    if (url.pathname === '/api/create-checkout' && request.method === 'POST') {
      return await handleCreateCheckout(request, env);
    }

    // Route: Verify subscription
    if (url.pathname === '/api/verify-subscription' && request.method === 'POST') {
      return await handleVerifySubscription(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// Check user's remaining usage
async function handleCheckUsage(request, env) {
  try {
    const { userId } = await request.json();
    
    // Get usage from KV storage
    const userKey = `user:${userId}`;
    const userData = await env.ALBUM_PLANNER_KV.get(userKey, { type: 'json' });
    
    const usage = userData?.usage || 0;
    const isPremium = userData?.isPremium || false;
    const premiumUntil = userData?.premiumUntil || null;

    // Check if premium subscription expired
    let activePremium = isPremium;
    if (isPremium && premiumUntil && new Date(premiumUntil) < new Date()) {
      activePremium = false;
    }

    return jsonResponse({
      usage,
      limit: activePremium ? 999999 : 20,
      isPremium: activePremium,
      remaining: activePremium ? 999999 : Math.max(0, 20 - usage)
    });
  } catch (error) {
    return jsonResponse({ error: 'Failed to check usage' }, 500);
  }
}

// Handle chat message
async function handleChat(request, env) {
  try {
    const { userId, message, albumContext } = await request.json();

    // Get user data
    const userKey = `user:${userId}`;
    const userData = await env.ALBUM_PLANNER_KV.get(userKey, { type: 'json' }) || {};
    
    const usage = userData.usage || 0;
    const isPremium = userData.isPremium || false;
    const premiumUntil = userData.premiumUntil || null;

    // Check if premium is still valid
    let activePremium = isPremium;
    if (isPremium && premiumUntil && new Date(premiumUntil) < new Date()) {
      activePremium = false;
    }

    // Check usage limit (free users: 20, premium: unlimited)
    if (!activePremium && usage >= 20) {
      return jsonResponse({
        error: 'usage_limit_reached',
        message: 'You have reached your free message limit. Please upgrade to continue.'
      }, 403);
    }

    // Call Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: `You are an experienced music producer helping musicians plan their album production. Here's the current album status:

Total Songs: ${albumContext.totalSongs}
Completed Songs: ${albumContext.completedSongs}
Songs In Progress: ${albumContext.songsInProgress}

Song Details:
${albumContext.songs.map(s => `- ${s.title}: Produced (${s.stages.Produced}), Vocals (${s.stages.Vocals}), Final Mix (${s.stages['Final Mix']}), Mastered (${s.stages.Mastered})`).join('\n')}

User's question: ${message}

Please provide practical, actionable advice for completing this album. Include realistic timeframes and specific next steps.`
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'API request failed');
    }

    // Increment usage count
    await env.ALBUM_PLANNER_KV.put(userKey, JSON.stringify({
      ...userData,
      usage: usage + 1,
      lastUsed: new Date().toISOString()
    }));

    return jsonResponse({
      response: data.content[0].text,
      usage: usage + 1,
      remaining: activePremium ? 999999 : Math.max(0, 19 - usage)
    });

  } catch (error) {
    console.error('Chat error:', error);
    return jsonResponse({ 
      error: 'chat_failed',
      message: 'Failed to process chat message: ' + error.message 
    }, 500);
  }
}

// Create Stripe checkout session
async function handleCreateCheckout(request, env) {
  try {
    const { userId, plan } = await request.json();

    // Plan pricing (in cents)
    const plans = {
      monthly: {
        amount: 499, // $4.99/month
        name: 'Monthly Premium',
        duration: 30
      },
      yearly: {
        amount: 4999, // $49.99/year
        name: 'Yearly Premium',
        duration: 365
      }
    };

    const selectedPlan = plans[plan];
    if (!selectedPlan) {
      return jsonResponse({ error: 'Invalid plan' }, 400);
    }

    // Create Stripe checkout session
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'payment',
        'success_url': `${env.FRONTEND_URL}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${env.FRONTEND_URL}?payment=cancelled`,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': selectedPlan.amount,
        'line_items[0][price_data][product_data][name]': selectedPlan.name,
        'line_items[0][quantity]': '1',
        'client_reference_id': userId,
        'metadata[plan]': plan,
        'metadata[userId]': userId,
        'metadata[duration]': selectedPlan.duration
      })
    });

    const session = await stripeResponse.json();

    if (!stripeResponse.ok) {
      throw new Error(session.error?.message || 'Stripe error');
    }

    return jsonResponse({ url: session.url });

  } catch (error) {
    console.error('Checkout error:', error);
    return jsonResponse({ 
      error: 'checkout_failed',
      message: error.message 
    }, 500);
  }
}

// Verify subscription after payment
async function handleVerifySubscription(request, env) {
  try {
    const { sessionId, userId } = await request.json();

    // Retrieve Stripe session
    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      {
        headers: {
          'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        }
      }
    );

    const session = await stripeResponse.json();

    if (!stripeResponse.ok || session.payment_status !== 'paid') {
      return jsonResponse({ error: 'Payment not completed' }, 400);
    }

    // Calculate premium expiry
    const duration = parseInt(session.metadata.duration);
    const premiumUntil = new Date();
    premiumUntil.setDate(premiumUntil.getDate() + duration);

    // Update user to premium
    const userKey = `user:${userId}`;
    const userData = await env.ALBUM_PLANNER_KV.get(userKey, { type: 'json' }) || {};

    await env.ALBUM_PLANNER_KV.put(userKey, JSON.stringify({
      ...userData,
      isPremium: true,
      premiumUntil: premiumUntil.toISOString(),
      plan: session.metadata.plan,
      paidAt: new Date().toISOString()
    }));

    return jsonResponse({
      success: true,
      isPremium: true,
      premiumUntil: premiumUntil.toISOString()
    });

  } catch (error) {
    console.error('Verification error:', error);
    return jsonResponse({ 
      error: 'verification_failed',
      message: error.message 
    }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
