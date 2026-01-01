// /js/pdf-export.js
// Professional PDF Report Generator using jsPDF + html2canvas

export async function generatePDFReport(reportData, userProfile) {
  // Load libraries
  await loadLibraries();
  
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('p', 'mm', 'letter'); // Portrait, Letter size
  
  const pageWidth = 216; // 8.5 inches
  const pageHeight = 279; // 11 inches
  const margin = 20;
  const contentWidth = pageWidth - (margin * 2);
  
  let yPos = margin;
  
  // ====================== PAGE 1: EXECUTIVE SUMMARY ======================
  
  // Header
  doc.setFillColor(15, 23, 42); // Dark blue
  doc.rect(0, 0, pageWidth, 40, 'F');
  
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.text('Economic Impact Report', margin, 22);
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  const orgName = userProfile?.organization || 'Your Organization';
  doc.text(orgName, margin, 32);
  
  yPos = 50;
  
  // Period badge
  doc.setTextColor(14, 165, 233);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(reportData.periodLabel || 'Report Period', margin, yPos);
  
  doc.setTextColor(100, 116, 139);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`${reportData.range.from} → ${reportData.range.to}`, margin, yPos + 5);
  
  yPos += 18;
  
  // Key Metrics Grid (2x2)
  doc.setTextColor(15, 23, 42);
  
  const metrics = [
    { label: 'Total Economic Impact', value: formatUSD(reportData.economicImpact), color: [16, 185, 129] },
    { label: 'Taxpayer Savings', value: formatUSD(reportData.taxpayerSavingsBase), color: [14, 165, 233] },
    { label: 'Tax Revenue Generated', value: formatUSD(reportData.taxes.federal + reportData.taxes.state + reportData.taxes.local), color: [139, 92, 246] },
    { label: 'Clients Served', value: reportData.clientsTotal.toLocaleString(), color: [251, 146, 60] }
  ];
  
  const boxWidth = (contentWidth - 10) / 2;
  const boxHeight = 35;
  let xPos = margin;
  
  metrics.forEach((metric, i) => {
    if (i === 2) {
      yPos += boxHeight + 5;
      xPos = margin;
    }
    
    // Box background
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(xPos, yPos, boxWidth, boxHeight, 3, 3, 'F');
    
    // Label
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(metric.label, xPos + 5, yPos + 8);
    
    // Value
    doc.setFontSize(20);
    doc.setTextColor(...metric.color);
    doc.setFont('helvetica', 'bold');
    doc.text(metric.value, xPos + 5, yPos + 22);
    
    xPos += boxWidth + 10;
  });
  
  yPos += boxHeight + 20;
  
  // Key Findings
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text('Key Findings', margin, yPos);
  yPos += 10;
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  
  const findings = [
    `${reportData.yesTotal.toLocaleString()} seniors avoided institutional care through community-based services`,
    `Every dollar invested generated $${((reportData.economicImpact / reportData.taxpayerSavingsBase) || 0).toFixed(2)} in total economic impact`,
    `Services created ${formatUSD(reportData.taxes.federal + reportData.taxes.state + reportData.taxes.local)} in new tax revenue`
  ];
  
  findings.forEach(finding => {
    // Bullet point
    doc.setFillColor(14, 165, 233);
    doc.circle(margin + 2, yPos - 2, 1.5, 'F');
    
    // Wrap text
    const lines = doc.splitTextToSize(finding, contentWidth - 10);
    doc.text(lines, margin + 8, yPos);
    yPos += lines.length * 5 + 3;
  });
  
  // Footer
  addFooter(doc, 1, pageHeight, margin, contentWidth);
  
  // ====================== PAGE 2: CHARTS ======================
  doc.addPage();
  yPos = margin;
  
  // Page header
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text('Visual Analysis', margin, yPos);
  yPos += 15;
  
  // Capture bar chart
  const barCanvas = document.getElementById('svcStackedBar');
  if (barCanvas) {
    try {
      const barImg = barCanvas.toDataURL('image/png', 1.0);
      doc.setFontSize(11);
      doc.setTextColor(100, 116, 139);
      doc.setFont('helvetica', 'normal');
      doc.text('Savings by Service Type', margin, yPos);
      yPos += 8;
      
      doc.addImage(barImg, 'PNG', margin, yPos, contentWidth, 80);
      yPos += 90;
    } catch (e) {
      console.warn('Could not capture bar chart:', e);
    }
  }
  
  // Capture pie chart
  const pieCanvas = document.getElementById('impactCompositionPie');
  if (pieCanvas) {
    try {
      const pieImg = pieCanvas.toDataURL('image/png', 1.0);
      doc.setFontSize(11);
      doc.setTextColor(100, 116, 139);
      doc.text('Economic Impact Composition', margin, yPos);
      yPos += 8;
      
      doc.addImage(pieImg, 'PNG', margin, yPos, contentWidth, 80);
    } catch (e) {
      console.warn('Could not capture pie chart:', e);
    }
  }
  
  addFooter(doc, 2, pageHeight, margin, contentWidth);
  
  // ====================== PAGE 3: SERVICE BREAKDOWN ======================
  doc.addPage();
  yPos = margin;
  
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text('Service Breakdown', margin, yPos);
  yPos += 15;
  
  // Table headers
  doc.setFillColor(248, 250, 252);
  doc.rect(margin, yPos, contentWidth, 10, 'F');
  
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.setFont('helvetica', 'bold');
  
  const colWidths = [50, 25, 25, 45, 45];
  let tableX = margin + 2;
  
  ['Service', 'Yes', 'No', 'Base Savings', 'Total Impact'].forEach((header, i) => {
    doc.text(header, tableX, yPos + 7);
    tableX += colWidths[i];
  });
  
  yPos += 12;
  
  // Table rows
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  doc.setFontSize(9);
  
  const selectedServices = Object.entries(reportData.perService)
    .filter(([key, data]) => data.yes > 0 || data.no > 0);
  
  selectedServices.forEach(([key, data]) => {
    tableX = margin + 2;
    
    // Alternate row colors
    if (selectedServices.indexOf([key, data]) % 2 === 0) {
      doc.setFillColor(252, 252, 253);
      doc.rect(margin, yPos - 5, contentWidth, 10, 'F');
    }
    
    const taxAlloc = (data.savedAdjusted / reportData.multipliedSavings) * 
                     (reportData.taxes.federal + reportData.taxes.state + reportData.taxes.local);
    const totalImpact = data.savedAdjusted + taxAlloc;
    
    doc.text(prettySvc(key), tableX, yPos);
    tableX += colWidths[0];
    doc.text(data.yes.toLocaleString(), tableX, yPos);
    tableX += colWidths[1];
    doc.text(data.no.toLocaleString(), tableX, yPos);
    tableX += colWidths[2];
    doc.text(formatCompactUSD(data.savedBase), tableX, yPos);
    tableX += colWidths[3];
    doc.text(formatCompactUSD(totalImpact), tableX, yPos);
    
    yPos += 10;
  });
  
  yPos += 10;
  
  // Service Narratives
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text('Service Impact Summaries', margin, yPos);
  yPos += 10;
  
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  
  selectedServices.forEach(([key, data]) => {
    const narrative = getServiceNarrative(key, data, reportData);
    
    // Service name as subheader
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(14, 165, 233);
    doc.text(prettySvc(key), margin, yPos);
    yPos += 6;
    
    // Narrative text
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(51, 65, 85);
    const lines = doc.splitTextToSize(narrative, contentWidth - 5);
    doc.text(lines, margin + 2, yPos);
    yPos += lines.length * 4 + 6;
    
    // Check if we need a new page
    if (yPos > pageHeight - 40) {
      doc.addPage();
      yPos = margin;
    }
  });
  
  addFooter(doc, 3, pageHeight, margin, contentWidth);
  
  // ====================== SAVE PDF ======================
  const fileName = `PolicyWorth-Report-${reportData.range.from}-to-${reportData.range.to}.pdf`;
  doc.save(fileName);
  
  return { success: true, fileName };
}

// ============ HELPERS ============

function addFooter(doc, pageNum, pageHeight, margin, contentWidth) {
  const footerY = pageHeight - 15;
  
  doc.setDrawColor(226, 232, 240);
  doc.line(margin, footerY - 5, margin + contentWidth, footerY - 5);
  
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.setFont('helvetica', 'normal');
  
  doc.text('PolicyWorth Economic Impact Report', margin, footerY);
  doc.text(`Page ${pageNum}`, margin + contentWidth - 15, footerY);
}

function formatUSD(n) {
  if (!isFinite(n)) return '$—';
  if (n >= 1000000) return `$${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function formatCompactUSD(n) {
  if (!isFinite(n)) return '$—';
  return n.toLocaleString(undefined, { 
    style: 'currency', 
    currency: 'USD', 
    notation: 'compact', 
    maximumFractionDigits: 1 
  });
}

function prettySvc(key) {
  return ({
    case_mgmt: 'Case Management',
    hdm: 'Home-Delivered Meals',
    caregiver_respite: 'Caregiver/Respite',
    crisis_intervention: 'Crisis Intervention',
  })[key] || key;
}

function getServiceNarrative(key, data, reportData) {
  const yesCount = data.yes;
  const baseUSD = data.savedBase;
  const taxAlloc = (data.savedAdjusted / reportData.multipliedSavings) * 
                   (reportData.taxes.federal + reportData.taxes.state + reportData.taxes.local);
  const totalImpact = data.savedAdjusted + taxAlloc;
  
  const narratives = {
    case_mgmt: `Case management services helped ${yesCount} seniors avoid premature institutional placement, generating ${formatUSD(baseUSD)} in direct healthcare savings and ${formatUSD(totalImpact)} in total economic impact through sustained independence.`,
    
    hdm: `Home-delivered meal programs served ${yesCount} seniors, preventing malnutrition and maintaining independence. This resulted in ${formatUSD(baseUSD)} in healthcare cost avoidance and ${formatUSD(totalImpact)} in total community benefit.`,
    
    caregiver_respite: `Respite services supported ${yesCount} family caregivers, preventing burnout and institutional placement. These interventions saved ${formatUSD(baseUSD)} in direct costs while generating ${formatUSD(totalImpact)} in broader economic value.`,
    
    crisis_intervention: `Rapid crisis response served ${yesCount} seniors in acute need, averting emergency room visits and institutional placement. Direct savings totaled ${formatUSD(baseUSD)}, with ${formatUSD(totalImpact)} in comprehensive economic impact.`
  };
  
  return narratives[key] || `Services supported ${yesCount} seniors, generating ${formatUSD(baseUSD)} in savings and ${formatUSD(totalImpact)} in total economic impact.`;
}

async function loadLibraries() {
  // Load jsPDF if not already loaded
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
}