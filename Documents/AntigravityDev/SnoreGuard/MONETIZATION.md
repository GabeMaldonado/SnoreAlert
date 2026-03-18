# SnoreGuard - Monetization Strategy & Implementation

**Last Updated**: February 20, 2026

---

## Overview

This document outlines the payment and subscription options for SnoreGuard, including implementation details, App Store setup, and testing procedures.

---

## Option 1: Auto-Renewable Subscription (RECOMMENDED)

### Why This Approach?
- ✅ Sustainable recurring revenue model
- ✅ Built-in trial handling by Apple
- ✅ Standard for health/wellness apps
- ✅ Users expect subscriptions for sleep tracking
- ✅ Easier implementation and maintenance

### Pricing Recommendation
- **Monthly**: $4.99/month
- **Annual**: $39.99/year (save 33%)
- **Free Trial**: 3 days (Apple minimum requirement)

**Note**: Apple requires minimum 3-day trial for auto-renewable subscriptions. Cannot do 2 days with this approach.

---

## Implementation Steps

### 1. App Store Connect Setup

#### Create Subscription Group
1. Log into [App Store Connect](https://appstoreconnect.apple.com)
2. Navigate to: **Your App → Features → In-App Purchases**
3. Click **"+"** → Select **"Auto-Renewable Subscription"**
4. Create subscription group:
   - **Name**: "SnoreGuard Premium"
   - **Reference Name**: "premium_subscription"

#### Configure Subscription Product
1. **Product Details**:
   - **Product ID**: `com.agenticdevlabs.snoreguard.monthly`
   - **Reference Name**: "SnoreGuard Monthly Premium"
   - **Subscription Duration**: 1 month

2. **Pricing**:
   - Select price tier: **$4.99** (Tier 5)
   - Enable **Free Trial**: 3 days
   - Auto-renew enabled

3. **Subscription Information**:
   - **Display Name**: "SnoreGuard Premium"
   - **Description**: "Unlimited snore detection, analytics, and Apple Watch integration"

4. **Review Information**:
   - Upload screenshot showing subscription benefits
   - Provide reviewer notes if needed

#### Optional: Add Annual Subscription
1. Create second product:
   - **Product ID**: `com.agenticdevlabs.snoreguard.annual`
   - **Duration**: 1 year
   - **Price**: $39.99
   - **Free Trial**: 3 days

---

### 2. Code Implementation

#### Install Dependencies
```bash
npm install react-native-iap
cd ios && pod install && cd ..
```

#### Update App.js

Add imports:
```javascript
import RNIap, {
  purchaseUpdatedListener,
  purchaseErrorListener,
  finishTransaction,
} from 'react-native-iap';
```

Add subscription constants:
```javascript
const SUBSCRIPTION_SKUS = {
  monthly: 'com.agenticdevlabs.snoreguard.monthly',
  annual: 'com.agenticdevlabs.snoreguard.annual',
};
```

Add state variables:
```javascript
const [hasActiveSubscription, setHasActiveSubscription] = useState(false);
const [isLoadingSubscription, setIsLoadingSubscription] = useState(true);
const [subscriptionProducts, setSubscriptionProducts] = useState([]);
```

Add IAP initialization (in useEffect):
```javascript
useEffect(() => {
  initIAP();

  // Purchase update listener
  const purchaseUpdateSubscription = purchaseUpdatedListener(
    async (purchase) => {
      const receipt = purchase.transactionReceipt;
      if (receipt) {
        try {
          await finishTransaction({ purchase });
          await checkSubscriptionStatus();
        } catch (error) {
          console.error('Finish transaction error:', error);
        }
      }
    }
  );

  // Purchase error listener
  const purchaseErrorSubscription = purchaseErrorListener(
    (error) => {
      console.error('Purchase error:', error);
    }
  );

  return () => {
    purchaseUpdateSubscription.remove();
    purchaseErrorSubscription.remove();
    RNIap.endConnection();
  };
}, []);

const initIAP = async () => {
  try {
    await RNIap.initConnection();
    await loadProducts();
    await checkSubscriptionStatus();
  } catch (err) {
    console.error('IAP init error:', err);
    setIsLoadingSubscription(false);
  }
};

const loadProducts = async () => {
  try {
    const products = await RNIap.getSubscriptions({
      skus: Object.values(SUBSCRIPTION_SKUS),
    });
    setSubscriptionProducts(products);
  } catch (err) {
    console.error('Load products error:', err);
  }
};

const checkSubscriptionStatus = async () => {
  try {
    const purchases = await RNIap.getAvailablePurchases();
    const activeSub = purchases.find(p =>
      p.productId === SUBSCRIPTION_SKUS.monthly ||
      p.productId === SUBSCRIPTION_SKUS.annual
    );
    setHasActiveSubscription(!!activeSub);
  } catch (err) {
    console.error('Check subscription error:', err);
  } finally {
    setIsLoadingSubscription(false);
  }
};

const purchaseSubscription = async (sku) => {
  try {
    await RNIap.requestSubscription({ sku });
  } catch (err) {
    if (err.code === 'E_USER_CANCELLED') {
      Alert.alert('Purchase Cancelled', 'You can subscribe anytime from Settings.');
    } else {
      Alert.alert('Purchase Error', err.message);
    }
  }
};
```

Update startMonitoring to check subscription:
```javascript
const startMonitoring = async () => {
  logEvent('startMonitoring called');
  if (!snoreDetectorRef.current) return;

  // Check subscription status
  if (!hasActiveSubscription && !isLoadingSubscription) {
    Alert.alert(
      'Subscription Required',
      'Start your free 3-day trial to use SnoreGuard!',
      [
        {
          text: 'Start Free Trial',
          onPress: () => purchaseSubscription(SUBSCRIPTION_SKUS.monthly)
        },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
    return;
  }

  // ... existing startMonitoring code
};
```

Add paywall UI (optional premium screen):
```javascript
const PaywallScreen = () => (
  <View style={styles.paywallContainer}>
    <Text style={styles.paywallTitle}>SnoreGuard Premium</Text>
    <Text style={styles.paywallSubtitle}>Start your free 3-day trial</Text>

    <View style={styles.featureList}>
      <Text style={styles.feature}>✓ Unlimited sleep sessions</Text>
      <Text style={styles.feature}>✓ Advanced analytics & insights</Text>
      <Text style={styles.feature}>✓ Apple Watch haptic alerts</Text>
      <Text style={styles.feature}>✓ Session history & trends</Text>
      <Text style={styles.feature}>✓ Export sleep data</Text>
    </View>

    {subscriptionProducts.map(product => (
      <TouchableOpacity
        key={product.productId}
        style={styles.subscriptionButton}
        onPress={() => purchaseSubscription(product.productId)}
      >
        <Text style={styles.subscriptionText}>
          {product.title} - {product.localizedPrice}
        </Text>
        <Text style={styles.subscriptionSubtext}>
          {product.productId.includes('annual') ? 'Save 33%' : 'Billed monthly'}
        </Text>
      </TouchableOpacity>
    ))}

    <Text style={styles.trialInfo}>
      Free for 3 days, then {subscriptionProducts[0]?.localizedPrice}/month.
      Cancel anytime.
    </Text>

    <TouchableOpacity onPress={() => setShowPaywall(false)}>
      <Text style={styles.restoreText}>Restore Purchases</Text>
    </TouchableOpacity>
  </View>
);
```

---

### 3. Testing with Sandbox

#### Create Sandbox Tester Account
1. **App Store Connect** → **Users and Access** → **Sandbox Testers**
2. Click **"+"** to add tester
3. Fill in details:
   - **Email**: Use unique email (e.g., `test+snoreguard1@gmail.com`)
   - **Password**: Create strong password
   - **First/Last Name**: Test User
   - **Country/Region**: United States

#### Test on Device
1. **Sign out** of real App Store account on iPhone:
   - Settings → App Store → Sign Out

2. **Build and run** app from Xcode

3. **Trigger purchase flow**:
   - Tap "Start Monitoring" (will show subscription prompt)
   - Tap "Start Free Trial"
   - Sign in with sandbox account when prompted

4. **Verify trial behavior**:
   - In sandbox, trials complete instantly (no need to wait 3 days)
   - Purchase should succeed
   - App should grant access

#### Testing Tips
- **Reset purchases**: Settings → App Store → Sandbox Account → Manage → Reset
- **Test renewal**: In sandbox, renewals happen much faster (e.g., 1 month = 5 minutes)
- **Test cancellation**: Go to Settings → Sandbox Account → Manage Subscriptions
- **Test restore**: Sign out and back in, restore should work

---

## Option 2: Custom Trial + One-Time Purchase

### Why This Approach?
- ✅ Allows exactly 2-day trial (user's original request)
- ✅ One-time payment (no recurring billing)
- ✅ Simpler for users who prefer ownership
- ❌ More complex implementation
- ❌ Less sustainable revenue model

### Pricing Recommendation
- **One-Time Price**: $19.99 (lifetime access)
- **Trial**: 2 days (custom logic)

---

### Implementation Steps

#### App Store Connect Setup
1. Create **Non-Consumable** In-App Purchase:
   - **Product ID**: `com.agenticdevlabs.snoreguard.lifetime`
   - **Reference Name**: "SnoreGuard Lifetime"
   - **Price**: $19.99

#### Code Implementation

Add trial tracking:
```javascript
const TRIAL_DURATION_DAYS = 2;
const TRIAL_START_KEY = '@snoreguard:trial_start';
const PURCHASE_KEY = '@snoreguard:has_purchased';

const [trialExpired, setTrialExpired] = useState(false);
const [hasPurchased, setHasPurchased] = useState(false);
const [trialDaysRemaining, setTrialDaysRemaining] = useState(2);

useEffect(() => {
  checkTrialStatus();
}, []);

const checkTrialStatus = async () => {
  // Check if purchased
  const purchased = await AsyncStorage.getItem(PURCHASE_KEY);
  if (purchased === 'true') {
    setHasPurchased(true);
    return;
  }

  // Check trial status
  let trialStart = await AsyncStorage.getItem(TRIAL_START_KEY);

  if (!trialStart) {
    // First launch - start trial
    trialStart = new Date().toISOString();
    await AsyncStorage.setItem(TRIAL_START_KEY, trialStart);
  }

  const startDate = new Date(trialStart);
  const now = new Date();
  const daysPassed = (now - startDate) / (1000 * 60 * 60 * 24);
  const daysRemaining = Math.max(0, TRIAL_DURATION_DAYS - Math.floor(daysPassed));

  setTrialDaysRemaining(daysRemaining);

  if (daysPassed >= TRIAL_DURATION_DAYS) {
    setTrialExpired(true);
  }
};

const purchaseFullVersion = async () => {
  try {
    await RNIap.initConnection();
    const products = await RNIap.getProducts({
      skus: ['com.agenticdevlabs.snoreguard.lifetime']
    });

    await RNIap.requestPurchase({
      sku: 'com.agenticdevlabs.snoreguard.lifetime'
    });

    await AsyncStorage.setItem(PURCHASE_KEY, 'true');
    setHasPurchased(true);
    setTrialExpired(false);

    Alert.alert('Success!', 'SnoreGuard unlocked permanently!');
  } catch (err) {
    if (err.code !== 'E_USER_CANCELLED') {
      Alert.alert('Purchase Error', err.message);
    }
  }
};
```

Update startMonitoring:
```javascript
const startMonitoring = async () => {
  if (trialExpired && !hasPurchased) {
    Alert.alert(
      'Trial Expired',
      'Your 2-day trial has ended. Purchase SnoreGuard to continue!',
      [
        { text: 'Purchase Now', onPress: purchaseFullVersion },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
    return;
  }

  // Show trial reminder
  if (!hasPurchased && trialDaysRemaining <= 1) {
    Alert.alert(
      `${trialDaysRemaining} Day${trialDaysRemaining !== 1 ? 's' : ''} Remaining`,
      'Purchase now to keep using SnoreGuard after your trial ends.',
      [
        { text: 'Purchase', onPress: purchaseFullVersion },
        { text: 'Continue', style: 'cancel' }
      ]
    );
  }

  // ... existing startMonitoring code
};
```

Add trial banner to home screen:
```javascript
{!hasPurchased && trialDaysRemaining > 0 && (
  <View style={styles.trialBanner}>
    <Text style={styles.trialText}>
      🎁 {trialDaysRemaining} day{trialDaysRemaining !== 1 ? 's' : ''} left in your free trial
    </Text>
    <TouchableOpacity onPress={purchaseFullVersion}>
      <Text style={styles.upgradeText}>Upgrade Now</Text>
    </TouchableOpacity>
  </View>
)}
```

---

## Comparison Table

| Feature | Auto-Renewable Subscription | Custom Trial + One-Time |
|---------|----------------------------|------------------------|
| **Trial Duration** | 3 days (Apple minimum) | 2 days (custom) |
| **Payment Model** | Monthly/Annual recurring | One-time purchase |
| **Revenue Type** | Recurring (sustainable) | One-time (upfront) |
| **Implementation** | Simpler (Apple handles trial) | More complex |
| **User Preference** | Common for apps | Good for users who prefer ownership |
| **Testing** | Sandbox accelerated renewals | Manual trial simulation |
| **Price Example** | $4.99/month or $39.99/year | $19.99 lifetime |
| **Apple Review** | Standard process | Standard process |

---

## Recommended Strategy

### Phase 1: Launch (Recommended)
**Auto-Renewable Subscription**
- 3-day free trial
- $4.99/month
- Simple implementation
- Sustainable revenue

### Phase 2: Optional Enhancement
Add **Annual Plan**:
- $39.99/year (save 33%)
- Same 3-day trial
- Encourage annual with discount

### Phase 3: Future Consideration
Add **Lifetime Option**:
- $49.99 one-time
- No trial (for loyal users who prefer ownership)
- Keep as premium tier alongside subscription

---

## Important App Store Requirements

### 1. Privacy Policy (REQUIRED)
Create privacy policy covering:
- Data collection (sleep patterns, snore events)
- Audio processing (on-device only)
- No data sharing with third parties
- User data deletion process

**Host at**: `https://yourdomain.com/privacy-policy`

### 2. Terms of Service
Cover:
- Subscription terms
- Auto-renewal
- Cancellation policy
- Refund policy (Apple handles)

### 3. App Store Metadata
**Description should mention**:
- Free trial duration
- Subscription price
- Auto-renewal terms
- How to cancel

**Example**:
> "SnoreGuard Premium includes a 3-day free trial. After the trial, your subscription will automatically renew at $4.99/month unless cancelled at least 24 hours before the end of the current period. Manage subscriptions in Settings."

---

## Legal Compliance

### Apple Guidelines
- **2.3.8**: Metadata must clearly state subscription terms
- **3.1.2**: All digital content must use Apple IAP (not third-party payment)
- **5.1.1**: Privacy policy required for apps collecting health data

### GDPR/Privacy
- Store minimal data
- Allow data export
- Provide data deletion
- Get consent for data collection

---

## Testing Checklist

Before submission:
- [ ] Subscription purchase flow works
- [ ] Trial starts correctly
- [ ] Trial expiration blocks access
- [ ] Restore purchases works
- [ ] Subscription renewal tested (sandbox)
- [ ] Cancellation tested
- [ ] Receipt validation works
- [ ] Offline behavior handled
- [ ] Error states tested (no internet, payment fails)
- [ ] Subscription status persists across app restarts

---

## Support & FAQ

### Common User Questions

**Q: How do I cancel my subscription?**
A: Settings → Your Name → Subscriptions → SnoreGuard → Cancel Subscription

**Q: Can I get a refund?**
A: Contact Apple Support within 90 days of purchase for refund requests.

**Q: What happens after my trial ends?**
A: You'll be charged $4.99/month automatically. Cancel anytime before trial ends to avoid charges.

**Q: Can I use SnoreGuard without paying?**
A: SnoreGuard offers a 3-day free trial. After that, a subscription is required.

---

## Next Steps

1. **Choose monetization model** (Recommendation: Option 1 - Auto-Renewable Subscription)
2. **Set up App Store Connect** (create subscription products)
3. **Implement IAP code** (add react-native-iap integration)
4. **Test with sandbox** (verify purchase flow)
5. **Create privacy policy** (required for submission)
6. **Submit for review** (include subscription screenshots)

---

*Document created February 20, 2026*
*Ready for implementation - awaiting user decision on monetization model*
