// /js/dashboard-pdf-export.js
// Professional PDF Report Generator for Dashboard

export async function generateDashboardPDF(dashboardData, userProfile) {
  // Load jsPDF library
  await loadLibraries();
  
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('p', 'mm', 'letter');
  
  const pageWidth = 216;
  const pageHeight = 279;
  const margin = 20;
  const contentWidth = pageWidth - (margin * 2);
  
  let yPos = margin;
  
  // ====================== PAGE 1: EXECUTIVE SUMMARY ======================
  
  // Header - Dark gradient
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 45, 'F');
  
  // Organization name
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  const orgName = userProfile?.organization || dashboardData.orgName || 'Your Organization';
  doc.text(orgName, margin, 18);
  
  // Report title
  doc.setFontSize(32);
  doc.setFont('helvetica', 'bold');
  doc.text('Economic Impact Report', margin, 30);
  
  // Subtitle
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(200, 200, 200);
  doc.text('Community-Based Care Services', margin, 38);
  
  yPos = 55;
  
  // Period badge
  doc.setTextColor(14, 165, 233);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Reporting Period', margin, yPos);
  
  doc.setTextColor(100, 116, 139);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const periodText = dashboardData.period || 'Annual 2024';
  doc.text(periodText, margin, yPos + 5);
  
  yPos += 18;
  
  // ====================== KEY METRICS GRID (2x2) ======================
  
  doc.setTextColor(15, 23, 42);
  
  const metrics = [
    { 
      label: 'Clients Served', 
      value: dashboardData.clientsServed?.toLocaleString() || '0',
      color: [14, 165, 233]
    },
    { 
      label: 'Total Economic Impact', 
      value: formatUSD(dashboardData.totalImpact || 0),
      color: [16, 185, 129]
    },
    { 
      label: 'Cost Avoidance', 
      value: formatUSD(dashboardData.baseSavings || 0),
      color: [139, 92, 246]
    },
    { 
      label: 'ROI', 
      value: `${dashboardData.roi || 0}%`,
      color: [251, 146, 60]
    }
  ];
  
  const boxWidth = (contentWidth - 10) / 2;
  const boxHeight = 32;
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
    doc.setFontSize(18);
    doc.setTextColor(...metric.color);
    doc.setFont('helvetica', 'bold');
    doc.text(metric.value, xPos + 5, yPos + 20);
    
    xPos += boxWidth + 10;
  });
  
  yPos += boxHeight + 20;
  
  // ====================== EXECUTIVE SUMMARY TEXT ======================
  
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text('Executive Summary', margin, yPos);
  yPos += 10;
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  
  const summaryText = dashboardData.execSummary || 
    `${orgName} provided community-based care services, preventing institutional placement and enabling individuals to age in place with dignity. These services generated significant economic impact to taxpayers and the community.`;
  
  const summaryLines = doc.splitTextToSize(summaryText, contentWidth);
  doc.text(summaryLines, margin, yPos);
  yPos += summaryLines.length * 5 + 15;
  
  // ====================== SCENARIO INFORMATION ======================
  
  if (dashboardData.scenario) {
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.text('Economic Impact Methodology', margin, yPos);
    yPos += 8;
    
    // Scenario box
    doc.setFillColor(240, 253, 244);
    doc.roundedRect(margin, yPos, contentWidth, 28, 3, 3, 'F');
    
    doc.setFontSize(10);
    doc.setTextColor(5, 150, 105);
    doc.setFont('helvetica', 'bold');
    doc.text(`${dashboardData.scenario.label} (${dashboardData.scenario.multiplier}× Multiplier)`, margin + 5, yPos + 8);
    
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'normal');
    const scenarioLines = doc.splitTextToSize(dashboardData.scenario.description || '', contentWidth - 10);
    doc.text(scenarioLines, margin + 5, yPos + 15);
    
    yPos += 35;
  }
  
  // ====================== DETAILED BREAKDOWN ======================
  
  if (dashboardData.detailedResults) {
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.text('Detailed Economic Breakdown', margin, yPos);
    yPos += 10;
    
    // Table header
    doc.setFillColor(248, 250, 252);
    doc.rect(margin, yPos, contentWidth, 8, 'F');
    
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'bold');
    
    const colWidths = [85, 45, 45];
    let tableX = margin + 2;
    
    ['Component', 'Annual', 'Total Impact'].forEach((header, i) => {
      doc.text(header, tableX, yPos + 5);
      tableX += colWidths[i];
    });
    
    yPos += 10;
    
    // Table rows
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(51, 65, 85);
    doc.setFontSize(9);
    
    const rows = [
      {
        label: `Cost Avoidance (${dashboardData.scenario?.multiplier || 1.5}×)`,
        annual: dashboardData.detailedResults.multipliedSavings || 0,
        total: (dashboardData.detailedResults.multipliedSavings || 0) * (dashboardData.years || 5)
      },
      {
        label: 'Senior Local Spending',
        annual: dashboardData.detailedResults.seniorSpending || 0,
        total: (dashboardData.detailedResults.seniorSpending || 0) * (dashboardData.years || 5)
      },
      {
        label: 'Tax Revenue (30%)',
        annual: dashboardData.detailedResults.totalTaxes || 0,
        total: (dashboardData.detailedResults.totalTaxes || 0) * (dashboardData.years || 5)
      }
    ];
    
    rows.forEach((row, idx) => {
      tableX = margin + 2;
      
      // Alternate row colors
      if (idx % 2 === 0) {
        doc.setFillColor(252, 252, 253);
        doc.rect(margin, yPos - 4, contentWidth, 8, 'F');
      }
      
      doc.text(row.label, tableX, yPos);
      tableX += colWidths[0];
      doc.text(formatCompactUSD(row.annual), tableX, yPos);
      tableX += colWidths[1];
      doc.text(formatCompactUSD(row.total), tableX, yPos);
      
      yPos += 8;
    });
    
    // Total row
    doc.setFillColor(240, 253, 244);
    doc.rect(margin, yPos - 4, contentWidth, 10, 'F');
    
    tableX = margin + 2;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(5, 150, 105);
    doc.setFontSize(10);
    doc.text('TOTAL', tableX, yPos + 2);
    tableX += colWidths[0];
    doc.text(formatCompactUSD(dashboardData.detailedResults.economicOutput || 0), tableX, yPos + 2);
    tableX += colWidths[1];
    doc.text(formatCompactUSD(dashboardData.detailedResults.totalEconomicBenefit || 0), tableX, yPos + 2);
  }
  
  // Footer
  addFooter(doc, 1, pageHeight, margin, contentWidth);
  
  // ====================== PAGE 2: CHARTS (IF AVAILABLE) ======================
  
  if (dashboardData.charts && (dashboardData.charts.cumulative || dashboardData.charts.comparison)) {
    doc.addPage();
    yPos = margin;
    
    doc.setFontSize(18);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.text('Financial Projections', margin, yPos);
    yPos += 15;
    
    // Cumulative chart
    if (dashboardData.charts.cumulative) {
      try {
        const cumulativeCanvas = document.getElementById('cumulativeChart');
        if (cumulativeCanvas) {
          const chartImg = cumulativeCanvas.toDataURL('image/png', 1.0);
          
          doc.setFontSize(11);
          doc.setTextColor(100, 116, 139);
          doc.setFont('helvetica', 'normal');
          doc.text('Cumulative Economic Impact', margin, yPos);
          yPos += 8;
          
          doc.addImage(chartImg, 'PNG', margin, yPos, contentWidth, 70);
          yPos += 80;
        }
      } catch (e) {
        console.warn('Could not capture cumulative chart:', e);
      }
    }
    
    // Comparison chart
    if (dashboardData.charts.comparison) {
      try {
        const comparisonCanvas = document.getElementById('comparisonChart');
        if (comparisonCanvas) {
          const chartImg = comparisonCanvas.toDataURL('image/png', 1.0);
          
          doc.setFontSize(11);
          doc.setTextColor(100, 116, 139);
          doc.setFont('helvetica', 'normal');
          doc.text('Scenario Comparison', margin, yPos);
          yPos += 8;
          
          doc.addImage(chartImg, 'PNG', margin, yPos, contentWidth, 70);
        }
      } catch (e) {
        console.warn('Could not capture comparison chart:', e);
      }
    }
    
    addFooter(doc, 2, pageHeight, margin, contentWidth);
  }
  
  // ====================== SAVE PDF ======================
  
  const period = dashboardData.period || 'Report';
  const fileName = `${orgName.replace(/[^a-z0-9]/gi, '-')}-Economic-Impact-${period.replace(/[^a-z0-9]/gi, '-')}.pdf`;
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
  
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  doc.text(date, margin + contentWidth / 2 - 15, footerY);
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

async function loadLibraries() {
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